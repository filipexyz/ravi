/**
 * Triggers Commands - Manage event-driven triggers
 */

import "reflect-metadata";
import { Group, Command, Arg, Option } from "../decorators.js";
import { fail, getContext } from "../context.js";
import { buildCliOffsetPagination, paginateCliItems } from "../pagination.js";
import { nats } from "../../nats.js";
import { getScopeContext, isScopeEnforced, canAccessResource } from "../../permissions/scope.js";
import { getAgent } from "../../router/config.js";
import { getAccountForAgent, getDefaultAgentId } from "../../router/router-db.js";
import { parseDurationMs, formatDurationMs } from "../../cron/schedule.js";
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

function serializeTrigger(trigger: Trigger) {
  return {
    ...trigger,
    effectiveAgentId: trigger.agentId ?? getDefaultAgentId(),
    cooldownDescription: formatDurationMs(trigger.cooldownMs),
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

@Group({
  name: "triggers",
  description: "Event triggers",
  scope: "resource",
})
export class TriggersCommands {
  @Command({ name: "topics", description: "List trigger-ready NATS topics" })
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
  list(
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--tag <slug>", description: "Filter by canonical trigger tag" }) tagSlug?: string,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching triggers to skip (default: 0)" }) offset?: string,
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
      baseCommand: ["ravi", "triggers", "list"],
      limit: page.limit,
      offset: page.offset,
      returned: pageTriggers.length,
      total: page.total,
      options: ["--tag", tagFilter],
    });

    const payload = {
      total: page.total,
      pagination,
      ...(tagFilter ? { filters: { tag: tagFilter } } : {}),
      items: pageTriggers.map(serializeTrigger),
      triggers: pageTriggers.map(serializeTrigger),
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
      console.log("  ravi triggers show <id>     # Show trigger details");
      console.log("  ravi triggers test <id>     # Test trigger with fake event");
      console.log("  ravi triggers rm <id>       # Delete trigger");
    }
    return payload;
  }

  @Command({ name: "show", description: "Show trigger details" })
  show(
    @Arg("id", { description: "Trigger ID" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const trigger = dbGetTrigger(id);
    if (!trigger || !canAccessResource(getScopeContext(), trigger.agentId)) {
      fail(`Trigger not found: ${id}`);
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
      console.log(`  Session:         ${trigger.session}`);
      if (trigger.replySession) {
        console.log(`  Reply session:   ${trigger.replySession}`);
      }
      console.log(`  Cooldown:        ${formatDurationMs(trigger.cooldownMs)}`);
      if (trigger.filter) {
        console.log(`  Filter:          ${trigger.filter}`);
      }
      console.log("");
      console.log(`  Message:`);
      console.log(`    ${trigger.message.split("\n").join("\n    ")}`);
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
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!topic) {
      fail("--topic is required");
    }
    const resolvedMessage = resolveTriggerMessage(topic, message);
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
    const replySession = ctx?.sessionName ?? ctx?.sessionKey;

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
  async enable(
    @Arg("id", { description: "Trigger ID" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const trigger = dbGetTrigger(id);
    if (!trigger || !canAccessResource(getScopeContext(), trigger.agentId)) {
      fail(`Trigger not found: ${id}`);
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
  async disable(
    @Arg("id", { description: "Trigger ID" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const trigger = dbGetTrigger(id);
    if (!trigger || !canAccessResource(getScopeContext(), trigger.agentId)) {
      fail(`Trigger not found: ${id}`);
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
  async set(
    @Arg("id", { description: "Trigger ID" }) id: string,
    @Arg("key", {
      description: "Property: name, message, topic, agent, account, session, cooldown",
    })
    key: string,
    @Arg("value", { description: "Property value" }) value: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const trigger = dbGetTrigger(id);
    if (!trigger || !canAccessResource(getScopeContext(), trigger.agentId)) {
      fail(`Trigger not found: ${id}`);
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
          updated = dbUpdateTrigger(id, { message: value, messageSource: "manual", messageTemplateId: null });
          logHuman(`✓ Message set: ${id}`);
          break;

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

        default:
          fail(`Unknown property: ${key}. Valid: name, message, topic, agent, account, session, cooldown, filter`);
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

  @Command({ name: "test", description: "Test trigger with fake event data" })
  async test(
    @Arg("id", { description: "Trigger ID" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const trigger = dbGetTrigger(id);
    if (!trigger || !canAccessResource(getScopeContext(), trigger.agentId)) {
      fail(`Trigger not found: ${id}`);
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
  async rm(
    @Arg("id", { description: "Trigger ID" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const trigger = dbGetTrigger(id);
    if (!trigger || !canAccessResource(getScopeContext(), trigger.agentId)) {
      fail(`Trigger not found: ${id}`);
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
