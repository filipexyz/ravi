/**
 * Triggers Commands - Manage event-driven triggers
 */

import "reflect-metadata";
import { Group, Command, CommandAccess, Arg, Option, Returns } from "../decorators.js";
import { contractDryRun, contractFail, pickFields, suggestSimilar } from "../agent-contract.js";
import { fail, getContext } from "../context.js";
import { buildCliOffsetPagination, paginateCliItems } from "../pagination.js";
import {
  triggerListReturnSchema,
  triggerMutationReturnSchema,
  triggerShowReturnSchema,
  triggerTopicsReturnSchema,
} from "./operational-return-schemas.js";
import { nats } from "../../nats.js";
import { getScopeContext, isScopeEnforced, canAccessResource } from "../../permissions/scope.js";
import { getAgent } from "../../router/config.js";
import { getAccountForAgent, getDefaultAgentId } from "../../router/router-db.js";
import { parseDurationMs, formatDurationMs } from "../../cron/schedule.js";
import { DEFAULT_CRON_SHELL_TIMEOUT_MS } from "../../cron/shell-executor.js";
import {
  dbCreateTrigger,
  dbGetTrigger,
  dbListTriggers,
  dbUpdateTrigger,
  dbDeleteTrigger,
  type TriggerInput,
  type Trigger,
} from "../../triggers/index.js";
import {
  findTriggerTopicCatalogEntry,
  getTriggerTopicCatalog,
  type TriggerTopicCatalogEntry,
} from "../../triggers/topic-catalog.js";
import { getTriggerTopicWarnings } from "../../triggers/topic-policy.js";
import { validateFilter } from "../../triggers/filter.js";
import { filterItemsByCanonicalTag } from "../../tags/helpers.js";

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

// ============================================================
// Manual v2 contract helpers (error envelope + suggestions).
// Text mode keeps the legacy `fail()` behavior; `--json` emits the
// {success:false, error:{code, ...suggestions}} envelope. Exit taxonomy:
// 1 not-found · 2 usage · 3 policy (write brake / dry-run).
// ============================================================

/**
 * Trigger ids are public through `triggers list`, so TRIGGER_NOT_FOUND enriches
 * the envelope with real similar ids/names. Candidates keep the same REBAC
 * visibility filter as `triggers list`, so scope isolation stays intact.
 */
function failTriggerNotFound(op: string, id: string, asJson?: boolean): never {
  const scopeCtx = getScopeContext();
  const candidates = dbListTriggers()
    .filter((trigger) => canAccessResource(scopeCtx, trigger.agentId))
    .flatMap((trigger) => [trigger.id, trigger.name]);
  contractFail(op, "TRIGGER_NOT_FOUND", `Trigger not found: ${id}`, {
    asJson,
    details: {
      suggestedAction: "Check the trigger id (see suggestions; list with: ravi triggers list --json)",
      suggestions: suggestSimilar(id, candidates),
    },
  });
}

function serializeTrigger(trigger: Trigger) {
  return {
    ...trigger,
    executionType: trigger.executionType ?? "agent",
    effectiveAgentId: trigger.agentId ?? getDefaultAgentId(),
    cooldownDescription: formatDurationMs(trigger.cooldownMs),
    shellTimeoutDescription:
      (trigger.executionType ?? "agent") === "shell"
        ? formatDurationMs(trigger.shellTimeoutMs ?? DEFAULT_CRON_SHELL_TIMEOUT_MS)
        : undefined,
  };
}

function printTopicSummary(): void {
  console.log("\nTrigger topic catalog:");
  for (const entry of getTriggerTopicCatalog().slice(0, 8)) {
    console.log(`  ${entry.pattern.padEnd(30)} ${entry.description}`);
  }
  console.log("  ... run `ravi triggers topics` for schemas, default messages, examples, and notes");
}

function printTopicCatalog(topics: TriggerTopicCatalogEntry[]): void {
  console.log("\nTrigger Topics:\n");
  let currentCategory: string | null = null;
  for (const entry of topics) {
    if (entry.category !== currentCategory) {
      currentCategory = entry.category;
      console.log(`${currentCategory.toUpperCase()}`);
    }
    console.log(`  ${entry.pattern}`);
    console.log(`    ${entry.description}`);
    console.log(`    payload: ${entry.payload}`);
    if (entry.schema?.fields.length) {
      const requiredFields = entry.schema.fields.filter((field) => field.required).map((field) => field.path);
      const optionalFields = entry.schema.fields.filter((field) => !field.required).map((field) => field.path);
      if (requiredFields.length) console.log(`    required: ${requiredFields.join(", ")}`);
      if (optionalFields.length) console.log(`    optional: ${optionalFields.slice(0, 8).join(", ")}`);
    }
    if (entry.messageTemplate) console.log(`    default message: ${entry.messageTemplate.template}`);
    if (entry.filters?.length) console.log(`    filters: ${entry.filters.join(" | ")}`);
    if (entry.examples[0]) console.log(`    example: ${entry.examples[0]}`);
    if (entry.notes?.length) {
      for (const note of entry.notes) console.log(`    note: ${note}`);
    }
  }
}

function printTopicWarnings(warnings: string[]): void {
  for (const warning of warnings) {
    console.warn(`Warning: ${warning}`);
  }
}

function assertValidTriggerFilter(filter: string | undefined): void {
  const validation = validateFilter(filter);
  if (!validation.ok) {
    fail(
      `Invalid filter: ${validation.error}. Use data.<path> <operator> "value"; combine with &&, ||, !, and parentheses.`,
    );
  }
}

function resolveTriggerMessage(topic: string, message: string | undefined) {
  const explicitMessage = message?.trim();
  if (explicitMessage) {
    return {
      message: explicitMessage,
      source: "explicit" as const,
      topicCatalogEntry: findTriggerTopicCatalogEntry(topic),
      templateId: undefined,
    };
  }

  const topicCatalogEntry = findTriggerTopicCatalogEntry(topic);
  const template = topicCatalogEntry?.messageTemplate;
  if (template?.template) {
    return {
      message: template.template,
      source: "catalog_default" as const,
      topicCatalogEntry,
      templateId: template.id,
    };
  }

  fail("--message is required for topics without a catalog default message template");
}

function parseTriggerShellTimeout(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      fail(`Invalid timeout: ${value}`);
    }
    return seconds * 1000;
  }
  try {
    return parseDurationMs(trimmed);
  } catch (err) {
    fail(`Invalid timeout: ${err instanceof Error ? err.message : err}`);
  }
}

function normalizeTriggerOnError(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "-" || trimmed === "null") return undefined;

  const prefix = "notify-session:";
  if (!trimmed.startsWith(prefix) || !trimmed.slice(prefix.length).trim()) {
    fail(`Invalid --on-error value: ${value}. Use notify-session:<session>`);
  }
  return `${prefix}${trimmed.slice(prefix.length).trim()}`;
}

@Group({
  name: "triggers",
  description: "Event triggers",
  scope: "resource",
})
export class TriggersCommands {
  @Command({ name: "topics", description: "List trigger-ready NATS topics" })
  @CommandAccess({ kind: "read", resource: "triggers", action: "topics", risk: "low" })
  @Returns(triggerTopicsReturnSchema)
  topics(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    const topics = getTriggerTopicCatalog();
    const payload = { topics };
    if (asJson) {
      printJson(payload);
    } else {
      printTopicCatalog(topics);
    }
    return payload;
  }

  @Command({ name: "list", description: "List all event triggers" })
  @CommandAccess({ kind: "read", resource: "triggers", action: "list", risk: "low" })
  @Returns(triggerListReturnSchema)
  list(
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--tag <slug>", description: "Filter by canonical trigger tag" }) tagSlug?: string,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching triggers to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--fields <a,b,c>", description: "Compact mode: keep only these fields of each item" })
    fields?: string,
  ) {
    let triggers = dbListTriggers();

    // Scope isolation: filter to own agent's triggers
    const scopeCtx = getScopeContext();
    if (isScopeEnforced(scopeCtx)) {
      triggers = triggers.filter((t) => canAccessResource(scopeCtx, t.agentId));
    }
    const tagFilter = tagSlug?.trim() || null;
    triggers = filterItemsByCanonicalTag(triggers, "trigger", tagFilter ?? undefined, (trigger) => trigger.id);
    const page = paginateCliItems(triggers, { limit, offset });
    const pageTriggers = page.items;
    const pagination = buildCliOffsetPagination({
      fields,
      baseCommand: ["ravi", "triggers", "list"],
      limit: page.limit,
      offset: page.offset,
      returned: pageTriggers.length,
      total: page.total,
      options: ["--tag", tagFilter],
    });

    // Compact mode (Manual v2 7.9): --fields narrows each serialized item.
    const serializedTriggers = pickFields(pageTriggers.map(serializeTrigger), fields);
    const payload = {
      total: page.total,
      pagination,
      ...(tagFilter ? { filters: { tag: tagFilter } } : {}),
      items: serializedTriggers,
      triggers: serializedTriggers,
    };

    if (asJson) {
      printJson(payload);
    } else if (pageTriggers.length === 0) {
      console.log("\nNo triggers configured.\n");
      console.log("Usage:");
      console.log(
        '  ravi triggers add "Contato alterado" --topic "ravi.*.cli.contacts.*" --message "Notifica o grupo"',
      );
      console.log(
        '  ravi triggers add "Permission Alert" --topic "ravi.audit.denied" --message "Analise o erro" --cooldown 1m',
      );
      printTopicSummary();
    } else {
      console.log("\nEvent Triggers:\n");
      console.log("  ID        NAME                      ENABLED  TOPIC                           FIRES");
      console.log("  --------  ------------------------  -------  ------------------------------  -----");

      for (const t of pageTriggers) {
        const id = t.id.padEnd(8);
        const name = t.name.slice(0, 24).padEnd(24);
        const enabled = (t.enabled ? "yes" : "no").padEnd(7);
        const topic = t.topic.slice(0, 30).padEnd(30);
        const fires = String(t.fireCount);

        console.log(`  ${id}  ${name}  ${enabled}  ${topic}  ${fires}`);
      }

      console.log(
        `\n  Total: ${page.total} triggers (${pageTriggers.length} returned, limit ${page.limit}, offset ${page.offset})`,
      );
      if (pagination.nextCommand) {
        console.log("\n  Next page:");
        console.log(`    ${pagination.nextCommand}`);
      }
      console.log("\nUsage:");
      console.log("  ravi triggers show <id>           # Show trigger details");
      console.log("  ravi triggers test <id>           # Test trigger with fake event");
      console.log("  ravi triggers rm <id> --execute   # Delete trigger (dry-run without --execute)");
    }
    return payload;
  }

  @Command({ name: "show", description: "Show trigger details" })
  @CommandAccess({ kind: "read", resource: "triggers", action: "show", risk: "low" })
  @Returns(triggerShowReturnSchema)
  show(
    @Arg("id", { description: "Trigger ID" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const trigger = dbGetTrigger(id);
    if (!trigger || !canAccessResource(getScopeContext(), trigger.agentId)) {
      failTriggerNotFound("triggers show", id, asJson);
    }

    const payload = { trigger: serializeTrigger(trigger) };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`\nTrigger: ${trigger.name}\n`);
      console.log(`  ID:              ${trigger.id}`);
      console.log(`  Agent:           ${trigger.agentId ?? "(default)"}`);
      console.log(`  Account:         ${trigger.accountId ?? "(auto)"}`);
      console.log(`  Enabled:         ${trigger.enabled ? "yes" : "no"}`);
      console.log(`  Topic:           ${trigger.topic}`);
      console.log(`  Execution:       ${trigger.executionType ?? "agent"}`);
      if ((trigger.executionType ?? "agent") === "shell") {
        console.log(`  Shell:           ${trigger.shellCommand ?? "(missing)"}`);
        console.log(`  Timeout:         ${formatDurationMs(trigger.shellTimeoutMs ?? DEFAULT_CRON_SHELL_TIMEOUT_MS)}`);
        if (trigger.shellEnvFile) console.log(`  Env file:        ${trigger.shellEnvFile}`);
        if (trigger.onError) console.log(`  On error:        ${trigger.onError}`);
      }
      console.log(`  Session:         ${trigger.session}`);
      if (trigger.replySession) {
        console.log(`  Reply session:   ${trigger.replySession}`);
      }
      console.log(`  Cooldown:        ${formatDurationMs(trigger.cooldownMs)}`);
      if (trigger.filter) {
        console.log(`  Filter:          ${trigger.filter}`);
      }
      console.log("");
      if ((trigger.executionType ?? "agent") === "agent") {
        console.log(`  Message:`);
        console.log(`    ${trigger.message.split("\n").join("\n    ")}`);
      }
      console.log("");
      console.log(`  Fire count:      ${trigger.fireCount}`);
      if (trigger.lastFiredAt) {
        console.log(`  Last fired:      ${new Date(trigger.lastFiredAt).toLocaleString()}`);
      }
      console.log(`  Created:         ${new Date(trigger.createdAt).toLocaleString()}`);

      printTopicSummary();
    }
    return payload;
  }

  @Command({ name: "add", description: "Add a new event trigger" })
  @CommandAccess({ kind: "mutate", resource: "triggers", action: "add", risk: "medium" })
  @Returns(triggerMutationReturnSchema)
  async add(
    @Arg("name", { description: "Trigger name" }) name: string,
    @Option({
      flags: "--topic <pattern>",
      description: "Notif topic pattern to subscribe to",
    })
    topic?: string,
    @Option({ flags: "--message <text>", description: "Prompt message (defaults to catalog template when available)" })
    message?: string,
    @Option({
      flags: "--agent <id>",
      description: "Agent ID (default: default agent)",
    })
    agent?: string,
    @Option({
      flags: "--account <name>",
      description: "Account for channel delivery (auto-detected from agent)",
    })
    account?: string,
    @Option({
      flags: "--cooldown <duration>",
      description: "Cooldown between fires (e.g., 5s, 30s, 1m)",
    })
    cooldown?: string,
    @Option({
      flags: "--session <type>",
      description: "Session: main or isolated (default: isolated)",
    })
    session?: string,
    @Option({
      flags: "--filter <expression>",
      description: "Filter expression (e.g. 'data.cwd == \"/path/to/workspace\"')",
    })
    filter?: string,
    @Option({
      flags: "--reply-session <name|key>",
      description: "Override the session used for outbound delivery (defaults to caller session)",
    })
    replySessionOverride?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--shell <cmd>", description: "Run a shell command directly without invoking an agent" })
    shell?: string,
    @Option({ flags: "--exec <cmd>", description: "Alias for --shell" })
    exec?: string,
    @Option({ flags: "--timeout <seconds|duration>", description: "Shell timeout, e.g. 60 or 5m" })
    timeout?: string,
    @Option({ flags: "--env-file <path>", description: "Env file loaded for shell triggers" })
    envFile?: string,
    @Option({ flags: "--on-error <action>", description: "Error action, e.g. notify-session:<session>" })
    onError?: string,
  ) {
    if (!topic) {
      fail("--topic is required");
    }
    const shellCommand = shell?.trim() || exec?.trim();
    const shellFlagCount = [shell, exec].filter((value) => value?.trim()).length;
    const isShellTrigger = Boolean(shellCommand);

    if (shellFlagCount > 1) {
      fail("Only one of --shell or --exec can be specified");
    }
    if (isShellTrigger && message) {
      fail("--message cannot be combined with --shell/--exec");
    }
    if (!isShellTrigger && (onError || timeout || envFile)) {
      fail("--on-error, --timeout and --env-file are only valid with --shell/--exec");
    }

    const resolvedMessage = isShellTrigger
      ? {
          message: "",
          source: "explicit" as const,
          topicCatalogEntry: findTriggerTopicCatalogEntry(topic),
          templateId: undefined,
        }
      : resolveTriggerMessage(topic, message);
    const topicWarnings = getTriggerTopicWarnings(topic);
    assertValidTriggerFilter(filter);

    // Validate agent if provided
    if (agent) {
      const ag = getAgent(agent);
      if (!ag) {
        fail(`Agent not found: ${agent}`);
      }
    }

    // Parse cooldown
    let cooldownMs = 5000;
    if (cooldown) {
      try {
        cooldownMs = parseDurationMs(cooldown);
      } catch (err) {
        fail(`Invalid cooldown: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Validate session
    let sessionTarget: "main" | "isolated" = "isolated";
    if (session) {
      if (session !== "main" && session !== "isolated") {
        fail(`Invalid session: ${session}. Valid: main, isolated`);
      }
      sessionTarget = session;
    }

    // Resolve agent: explicit flag > caller agent (from session context)
    const ctx = getContext();
    const resolvedAgent = agent ?? ctx?.agentId;

    // Resolve account in this order:
    //   1. explicit --account flag
    //   2. account the caller was actually talking through (ctx.source.accountId)
    //   3. instance explicitly mapped to the agent
    // We deliberately avoid the "first enabled instance" fallback inside
    // getAccountForAgent: it picks the wrong account in multi-account setups
    // and causes outbound deliveries to fail with "chat not found".
    const resolvedAccount =
      account ?? ctx?.source?.accountId ?? (resolvedAgent ? getAccountForAgent(resolvedAgent) : undefined);

    // Capture reply session from caller context for source routing.
    // Prefer the friendly session name when available so `triggers show`
    // surfaces something legible; resolveSession accepts both name and
    // session_key, so resolution at fire time is identical either way.
    // --reply-session overrides the auto-capture when the caller knows the
    // trigger should reply to a different session than the one creating it.
    const replySession = replySessionOverride?.trim() || (ctx?.sessionName ?? ctx?.sessionKey);

    // Freeze the creator's outbound source as a fallback for when the live
    // session can no longer resolve a deliverable target (lastChannel empty,
    // channel routed to "tui", etc).
    const callerSource = ctx?.source;
    const replySource =
      callerSource?.channel && callerSource?.accountId && callerSource?.chatId
        ? {
            channel: callerSource.channel,
            accountId: callerSource.accountId,
            chatId: callerSource.chatId,
            ...(callerSource.threadId ? { threadId: callerSource.threadId } : {}),
          }
        : undefined;

    const input: TriggerInput = {
      name,
      topic,
      message: resolvedMessage.message,
      executionType: isShellTrigger ? "shell" : "agent",
      shellCommand: isShellTrigger ? shellCommand : undefined,
      shellTimeoutMs: isShellTrigger ? parseTriggerShellTimeout(timeout) : undefined,
      shellEnvFile: isShellTrigger ? envFile : undefined,
      onError: isShellTrigger ? normalizeTriggerOnError(onError) : undefined,
      messageSource: resolvedMessage.source === "catalog_default" ? "catalog" : "manual",
      messageTemplateId: resolvedMessage.templateId ?? null,
      agentId: resolvedAgent,
      accountId: resolvedAccount,
      replySession,
      replySource,
      session: sessionTarget,
      cooldownMs,
      filter,
    };

    try {
      const trigger = dbCreateTrigger(input);

      await nats.emit("ravi.triggers.refresh", {});

      const payload = {
        status: "created" as const,
        target: { type: "trigger" as const, id: trigger.id },
        changedCount: 1,
        trigger: serializeTrigger(trigger),
        messageTemplate: {
          source: resolvedMessage.source,
          topicId: resolvedMessage.topicCatalogEntry?.id ?? null,
          templateId: resolvedMessage.templateId ?? null,
        },
        ...(topicWarnings.length ? { warnings: topicWarnings } : {}),
      };
      if (asJson) {
        printJson(payload);
      } else {
        printTopicWarnings(topicWarnings);
        console.log(`\n✓ Created trigger: ${trigger.id}`);
        console.log(`  Name:       ${trigger.name}`);
        console.log(`  Topic:      ${trigger.topic}`);
        if (resolvedMessage.source === "catalog_default") {
          console.log(`  Message:    catalog default (${resolvedMessage.templateId})`);
        }
        console.log(`  Cooldown:   ${formatDurationMs(trigger.cooldownMs)}`);
        console.log(`  Session:    ${trigger.session}`);
      }
      return payload;
    } catch (err) {
      fail(`Error creating trigger: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "enable", description: "Enable a trigger" })
  @CommandAccess({ kind: "mutate", resource: "triggers", action: "enable", risk: "medium" })
  @Returns(triggerMutationReturnSchema)
  async enable(
    @Arg("id", { description: "Trigger ID" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const trigger = dbGetTrigger(id);
    if (!trigger || !canAccessResource(getScopeContext(), trigger.agentId)) {
      failTriggerNotFound("triggers enable", id, asJson);
    }

    try {
      const updated = dbUpdateTrigger(id, { enabled: true });
      await nats.emit("ravi.triggers.refresh", {});
      const payload = {
        status: "enabled" as const,
        target: { type: "trigger" as const, id },
        changedCount: 1,
        trigger: serializeTrigger(updated),
      };
      if (asJson) {
        printJson(payload);
      } else {
        console.log(`✓ Enabled trigger: ${id} (${trigger.name})`);
      }
      return payload;
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "disable", description: "Disable a trigger" })
  @CommandAccess({ kind: "mutate", resource: "triggers", action: "disable", risk: "medium" })
  @Returns(triggerMutationReturnSchema)
  async disable(
    @Arg("id", { description: "Trigger ID" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const trigger = dbGetTrigger(id);
    if (!trigger || !canAccessResource(getScopeContext(), trigger.agentId)) {
      failTriggerNotFound("triggers disable", id, asJson);
    }

    try {
      const updated = dbUpdateTrigger(id, { enabled: false });
      await nats.emit("ravi.triggers.refresh", {});
      const payload = {
        status: "disabled" as const,
        target: { type: "trigger" as const, id },
        changedCount: 1,
        trigger: serializeTrigger(updated),
      };
      if (asJson) {
        printJson(payload);
      } else {
        console.log(`✓ Disabled trigger: ${id} (${trigger.name})`);
      }
      return payload;
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "set", description: "Set trigger property" })
  @CommandAccess({ kind: "mutate", resource: "triggers", action: "set", risk: "medium" })
  @Returns(triggerMutationReturnSchema)
  async set(
    @Arg("id", { description: "Trigger ID" }) id: string,
    @Arg("key", {
      description:
        "Property: name, message, shell, exec, timeout, env-file, on-error, topic, agent, account, session, cooldown, filter, replySession",
    })
    key: string,
    @Arg("value", { description: "Property value" }) value: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const trigger = dbGetTrigger(id);
    if (!trigger || !canAccessResource(getScopeContext(), trigger.agentId)) {
      failTriggerNotFound("triggers set", id, asJson);
    }

    try {
      let updated: Trigger | null = null;
      let normalizedValue: unknown = value;
      let warnings: string[] = [];
      const logHuman = (message: string) => {
        if (!asJson) console.log(message);
      };

      switch (key) {
        case "name":
          updated = dbUpdateTrigger(id, { name: value });
          logHuman(`✓ Name set: ${id} -> ${value}`);
          break;

        case "message":
          updated = dbUpdateTrigger(id, {
            message: value,
            executionType: "agent",
            shellCommand: null,
            shellTimeoutMs: null,
            shellEnvFile: null,
            onError: null,
            messageSource: "manual",
            messageTemplateId: null,
          });
          logHuman(`✓ Message set: ${id}`);
          break;

        case "shell":
        case "exec": {
          const shellCommand = value.trim();
          if (!shellCommand) {
            fail("Shell command cannot be empty");
          }
          updated = dbUpdateTrigger(id, {
            executionType: "shell",
            shellCommand,
            message: "",
            messageSource: "manual",
            messageTemplateId: null,
          });
          logHuman(`✓ Shell command set: ${id}`);
          break;
        }

        case "timeout": {
          if ((trigger.executionType ?? "agent") !== "shell") {
            fail("timeout only applies to shell triggers");
          }
          const shellTimeoutMs = value === "null" || value === "-" ? null : parseTriggerShellTimeout(value);
          updated = dbUpdateTrigger(id, { shellTimeoutMs });
          normalizedValue = shellTimeoutMs;
          logHuman(`✓ Shell timeout set: ${id} -> ${shellTimeoutMs ? formatDurationMs(shellTimeoutMs) : "(default)"}`);
          break;
        }

        case "env-file": {
          if ((trigger.executionType ?? "agent") !== "shell") {
            fail("env-file only applies to shell triggers");
          }
          const shellEnvFile = value === "null" || value === "-" ? null : value;
          updated = dbUpdateTrigger(id, { shellEnvFile });
          normalizedValue = shellEnvFile;
          logHuman(`✓ Shell env file set: ${id} -> ${shellEnvFile ?? "(none)"}`);
          break;
        }

        case "on-error": {
          if ((trigger.executionType ?? "agent") !== "shell") {
            fail("on-error only applies to shell triggers");
          }
          const normalizedOnError = normalizeTriggerOnError(value);
          updated = dbUpdateTrigger(id, { onError: normalizedOnError ?? null });
          normalizedValue = normalizedOnError ?? null;
          logHuman(`✓ Shell on-error set: ${id} -> ${normalizedOnError ?? "(none)"}`);
          break;
        }

        case "topic": {
          warnings = getTriggerTopicWarnings(value);
          updated = dbUpdateTrigger(id, { topic: value });
          if (!asJson) printTopicWarnings(warnings);
          logHuman(`✓ Topic set: ${id} -> ${value}`);
          break;
        }

        case "agent": {
          const agentId = value === "null" || value === "-" ? undefined : value;
          if (agentId) {
            const ag = getAgent(agentId);
            if (!ag) {
              fail(`Agent not found: ${agentId}`);
            }
          }
          updated = dbUpdateTrigger(id, { agentId });
          normalizedValue = agentId ?? null;
          logHuman(`✓ Agent set: ${id} -> ${agentId ?? "(default)"}`);
          break;
        }

        case "account": {
          const accountId = value === "null" || value === "-" ? undefined : value;
          updated = dbUpdateTrigger(id, { accountId });
          normalizedValue = accountId ?? null;
          logHuman(`✓ Account set: ${id} -> ${accountId ?? "(auto)"}`);
          break;
        }

        case "session": {
          const validValues = ["main", "isolated"];
          if (!validValues.includes(value)) {
            fail(`Invalid session value: ${value}. Valid: ${validValues.join(", ")}`);
          }
          updated = dbUpdateTrigger(id, {
            session: value as "main" | "isolated",
          });
          logHuman(`✓ Session set: ${id} -> ${value}`);
          break;
        }

        case "cooldown": {
          const ms = parseDurationMs(value);
          updated = dbUpdateTrigger(id, { cooldownMs: ms });
          normalizedValue = ms;
          logHuman(`✓ Cooldown set: ${id} -> ${formatDurationMs(ms)}`);
          break;
        }

        case "filter": {
          const filterValue = value === "null" || value === "-" ? undefined : value;
          assertValidTriggerFilter(filterValue);
          updated = dbUpdateTrigger(id, { filter: filterValue });
          normalizedValue = filterValue ?? null;
          logHuman(`✓ Filter set: ${id} -> ${filterValue ?? "(none)"}`);
          break;
        }

        case "replySession": {
          // null/undefined distinction matters here: dbUpdateTrigger's outer
          // guard skips fields that are `undefined`, so passing `undefined`
          // for a clear request would leave the column unchanged. Use `null`
          // to force the SQL UPDATE to set reply_session = NULL.
          const cleared = value === "null" || value === "-";
          const replySession: string | null = cleared ? null : value.trim();
          updated = dbUpdateTrigger(id, { replySession });
          normalizedValue = replySession;
          logHuman(`✓ Reply session set: ${id} -> ${replySession ?? "(none)"}`);
          break;
        }

        default:
          fail(
            `Unknown property: ${key}. Valid: name, message, shell, exec, timeout, env-file, on-error, topic, agent, account, session, cooldown, filter, replySession`,
          );
      }

      await nats.emit("ravi.triggers.refresh", {});
      const current = updated ?? dbGetTrigger(id);
      const payload = {
        status: "updated" as const,
        target: { type: "trigger" as const, id },
        changedCount: 1,
        property: key,
        value: normalizedValue,
        trigger: current ? serializeTrigger(current) : null,
        ...(warnings.length ? { warnings } : {}),
      };
      if (asJson) {
        printJson(payload);
      }
      return payload;
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Test execution uses fake event data (`_test: true`) to preview a trigger,
  // but dispatch can still activate agent or shell execution.
  // It therefore requires --execute before emitting to the runtime.
  @Command({ name: "test", description: "Test trigger with fake event data" })
  @CommandAccess({
    kind: "mutate",
    resource: "triggers",
    action: "test",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(triggerMutationReturnSchema)
  async test(
    @Arg("id", { description: "Trigger ID" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually emit the synthetic trigger event; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    const trigger = dbGetTrigger(id);
    if (!trigger || !canAccessResource(getScopeContext(), trigger.agentId)) {
      failTriggerNotFound("triggers test", id, asJson);
    }

    if (execute !== true) {
      contractDryRun(
        "triggers test",
        {
          triggerId: id,
          executionType: trigger.executionType ?? "agent",
        },
        { asJson },
      );
    }

    if (!asJson) {
      console.log(`\nTesting trigger: ${trigger.name}`);
      console.log(`  Topic: ${trigger.topic}`);
    }

    try {
      await nats.emit("ravi.triggers.test", { triggerId: id });
      const payload = {
        status: "test_emitted" as const,
        target: { type: "trigger" as const, id },
        changedCount: 0,
        trigger: serializeTrigger(trigger),
      };
      if (asJson) {
        printJson(payload);
      } else {
        console.log("✓ Test event sent");
        console.log("  Check daemon logs: ravi daemon logs -f");
      }
      return payload;
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({
    name: "rm",
    description: "Delete a trigger",
    aliases: ["delete", "remove"],
  })
  @CommandAccess({
    kind: "mutate",
    resource: "triggers",
    action: "rm",
    risk: "destructive",
    requiresConfirmation: true,
  })
  @Returns(triggerMutationReturnSchema)
  async rm(
    @Arg("id", { description: "Trigger ID" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually delete the trigger; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    const trigger = dbGetTrigger(id);
    if (!trigger || !canAccessResource(getScopeContext(), trigger.agentId)) {
      failTriggerNotFound("triggers rm", id, asJson);
    }

    if (execute !== true) {
      // Write brake (Manual v2 7.8): deleting a trigger is destructive (topic
      // subscription and config are gone), so dry-run by default and exit 3
      // before any state change.
      contractDryRun(
        "triggers rm",
        {
          triggerId: id,
          executionType: trigger.executionType ?? "agent",
          enabled: trigger.enabled,
        },
        { asJson },
      );
    }

    try {
      dbDeleteTrigger(id);
      await nats.emit("ravi.triggers.refresh", {});
      const payload = {
        status: "deleted" as const,
        target: { type: "trigger" as const, id },
        changedCount: 1,
        trigger: serializeTrigger(trigger),
      };
      if (asJson) {
        printJson(payload);
      } else {
        console.log(`✓ Deleted trigger: ${id} (${trigger.name})`);
      }
      return payload;
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }
}
