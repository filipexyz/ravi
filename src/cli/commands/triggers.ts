import { errorDiagnostic } from "../../utils/error-diagnostic.js";
/**
 * Triggers Commands - Manage event-driven triggers
 */

import "reflect-metadata";
import { Group, Command, CommandAccess, Arg, Option, Returns } from "../decorators.js";
import { CONTRACT_EXIT_POLICY, contractDryRun, contractFail, pickFields, suggestSimilar } from "../agent-contract.js";
import { shellEnvFileRefusal } from "../../triggers/shell-env-file.js";
import { fail, getContext } from "../context.js";
import { buildCliOffsetPagination, paginateCliItems } from "../pagination.js";
import {
  triggerListReturnSchema,
  triggerMutationReturnSchema,
  triggerShowReturnSchema,
  triggerTopicsReturnSchema,
} from "./operational-return-schemas.js";
import { nats } from "../../nats.js";
import {
  getScopeContext,
  isScopeEnforced,
  canAccessResource,
  canModifySession,
  recordResourceAccessDenial,
  type ScopeContext,
} from "../../permissions/scope.js";
import { resolveSession } from "../../router/sessions.js";
import { getAgent } from "../../router/config.js";
import { getAccountForAgent, getDefaultAgentId } from "../../router/router-db.js";
import { parseDurationMs, formatDurationMs } from "../../cron/schedule.js";
import { parseOptionalDurationMs } from "../../triggers/debounce.js";
import { DEFAULT_CRON_SHELL_TIMEOUT_MS } from "../../cron/shell-executor.js";
import { assertShellAutomationAuthorized } from "../../permissions/shell-automation.js";
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
import { resolveTriggerActivation } from "../../triggers/activation.js";
import {
  TRIGGER_OWNER_NEUTRAL_SET_KEYS,
  ownerKeptOnEnable,
  resolveTriggerOwnerForCurrentTurn,
  triggerOwnerActsAsOperator,
  triggerOwnerLostWarning,
  triggerRunsAs,
  triggerIsolatedSessionName,
  triggerRunsAsWarning,
  triggerRunsInOwnSession,
  triggerSessionTargetError,
} from "../../triggers/ownership.js";
import { isPersonPrincipal, isTriggerOwnSessionKey } from "../../triggers/authority.js";
import { isLegacySessionTarget, sessionTargetError, type SessionTarget } from "../../triggers/types.js";
import { filterItemsByCanonicalTag } from "../../tags/helpers.js";
import { assertNoUserOverlayAutomationWrite } from "../../permissions/user-overlay-automation.js";

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
 * A trigger without an explicit agent fires as the default agent, so that
 * agent is its effective owner for visibility and mutation checks.
 */
function triggerOwnerId(trigger: Pick<Trigger, "agentId">): string {
  return trigger.agentId ?? getDefaultAgentId();
}

function canReadTrigger(scopeCtx: ScopeContext, trigger: Pick<Trigger, "agentId">): boolean {
  return canAccessResource(scopeCtx, triggerOwnerId(trigger), "read");
}

/**
 * Trigger ids are public through `triggers list`, so TRIGGER_NOT_FOUND enriches
 * the envelope with real similar ids/names. Candidates keep the same REBAC
 * visibility filter as `triggers list`, so scope isolation stays intact.
 */
/**
 * Same rule as shell cron jobs (`CRON_SHELL_NOT_OPERATOR`): a shell trigger's
 * command runs with this machine's access, so only an owner that acts as the
 * operator may create one or change what it runs or the env it gets. The
 * runner checks the owner again on every fire.
 */
function assertShellTriggerOwnerActsAsOperator(op: string, ownerPrincipal: string, asJson?: boolean): void {
  if (triggerOwnerActsAsOperator(ownerPrincipal)) return;
  const owner = ownerPrincipal || "unknown";
  const suggestedAction =
    "do not retry from this turn; use an agent trigger (--message) instead, which runs as its creator, or ask the operator to create the shell trigger from the terminal or their own chat";
  const message = `A shell trigger would run as ${owner}, not the operator. A shell command runs with this machine's access, so only the operator can own one. Next: ${suggestedAction}.`;
  contractFail(op, "TRIGGER_SHELL_NOT_OPERATOR", message, {
    ...{
      asJson,
      exitCode: CONTRACT_EXIT_POLICY,
      details: { ownerPrincipal: owner, suggestedAction },
    },
    diagnostic: errorDiagnostic(message, { operation: op }),
  });
}

function failShellTrigger(
  op: string,
  code: string,
  message: string,
  details: Record<string, unknown>,
  asJson?: boolean,
): never {
  contractFail(op, code, message, {
    ...{ asJson, exitCode: CONTRACT_EXIT_POLICY, details },
    diagnostic: errorDiagnostic(message, { operation: op }),
  });
}

/**
 * Who may create or change a shell trigger. Its command runs with this
 * machine's access, so all of these hold:
 * - the request reached the daemon with a context it verified (a turn, through
 *   the gateway or a tool call): a local `ravi` with no context cannot prove
 *   who it is, since any process on the machine can run one;
 * - the requester acts as the operator;
 * - for an existing trigger, the requester is its owner: an edit by anyone
 *   else would clear the owner, and an ownerless shell trigger never runs, so
 *   that edit would turn the owner's trigger off.
 */
function assertShellTriggerChange(
  op: string,
  trigger: Pick<Trigger, "id" | "ownerPrincipal" | "executionType"> | null,
  asJson?: boolean,
): void {
  const transport = getContext({ localOnly: true })?.transport;
  if (transport !== "gateway" && transport !== "tool") {
    const suggestedAction =
      "ask the operator to do it from their own chat with Ravi, where the daemon verifies the request; an agent trigger (--message) is not held to this";
    failShellTrigger(
      op,
      "TRIGGER_SHELL_NOT_OPERATOR",
      `A shell trigger is created or changed only from a request the daemon verified, and this one came from a local ravi with no runtime context. Next: ${suggestedAction}.`,
      { suggestedAction },
      asJson,
    );
  }
  const requester = resolveTriggerOwnerForCurrentTurn();
  assertShellTriggerOwnerActsAsOperator(op, requester, asJson);
  if (trigger && (trigger.ownerPrincipal ?? "") !== requester) {
    const owner = triggerRunsAs(trigger);
    const suggestedAction = `ask its owner to change it, or create a new shell trigger from this turn (ravi triggers add <name> --topic <topic> --shell <cmd>) and remove this one (ravi triggers rm ${trigger.id} --execute)`;
    failShellTrigger(
      op,
      "TRIGGER_SHELL_NOT_OPERATOR",
      `Trigger ${trigger.id} runs as ${owner}, and only its owner changes a shell trigger: an edit by anyone else would leave it with no owner, and a shell trigger with no owner does not run. Next: ${suggestedAction}.`,
      { ownerPrincipal: owner, suggestedAction },
      asJson,
    );
  }
}

/**
 * The env file of a shell trigger must be a regular file outside the Ravi
 * state dir, with a single hard link and at most 1 MiB, owned by the user Ravi
 * runs as and not writable by its group or others, and one the check can
 * verify (see `shell-env-file.ts`). The location part is a path check, not an
 * access boundary.
 */
function assertShellEnvFileAllowed(op: string, envFile: string | null | undefined, asJson?: boolean): void {
  if (!envFile) return;
  const refusal = shellEnvFileRefusal(envFile);
  if (!refusal) return;
  const suggestedAction =
    "put only the variables the command needs in a regular file of its own outside the Ravi state dir, given by a path without .., owned by the user Ravi runs as and writable only by it (chmod 600)";
  if (refusal === "unverifiable") {
    failShellTrigger(
      op,
      "TRIGGER_SHELL_ENV_FILE_UNVERIFIABLE",
      `The env file ${envFile} could not be checked: a symlink loop, or a path Ravi may not search or read. Next: ${suggestedAction}.`,
      { envFile, suggestedAction },
      asJson,
    );
  }
  if (refusal === "not_owned") {
    failShellTrigger(
      op,
      "TRIGGER_SHELL_ENV_FILE_NOT_OWNED",
      `The env file ${envFile} belongs to another OS user, who could decide what the command runs. Next: ${suggestedAction}.`,
      { envFile, suggestedAction },
      asJson,
    );
  }
  if (refusal === "writable_by_others") {
    failShellTrigger(
      op,
      "TRIGGER_SHELL_ENV_FILE_WRITABLE_BY_OTHERS",
      `The env file ${envFile} is writable by its group or by others, who could decide what the command runs. Next: ${suggestedAction}.`,
      { envFile, suggestedAction },
      asJson,
    );
  }
  if (refusal === "not_regular_file") {
    failShellTrigger(
      op,
      "TRIGGER_SHELL_ENV_FILE_NOT_REGULAR",
      `The env file ${envFile} is not a regular file (a FIFO, a device or a directory). Next: ${suggestedAction}.`,
      { envFile, suggestedAction },
      asJson,
    );
  }
  if (refusal === "too_large") {
    failShellTrigger(
      op,
      "TRIGGER_SHELL_ENV_FILE_TOO_LARGE",
      `The env file ${envFile} is larger than 1 MiB, the most the env-file loader reads. Next: ${suggestedAction}.`,
      { envFile, suggestedAction },
      asJson,
    );
  }
  if (refusal === "hard_link") {
    failShellTrigger(
      op,
      "TRIGGER_SHELL_ENV_FILE_HARD_LINK",
      `The env file ${envFile} has more than one hard link, so its content may be a file inside the Ravi state dir. Next: ${suggestedAction}.`,
      { envFile, suggestedAction },
      asJson,
    );
  }
  failShellTrigger(
    op,
    "TRIGGER_SHELL_ENV_FILE_IN_STATE_DIR",
    `The env file ${envFile} is inside the Ravi state dir, which holds the daemon's own secrets, or its path has a .. segment that could lead there. Next: ${suggestedAction}.`,
    { envFile, suggestedAction },
    asJson,
  );
}

function failTriggerNotFound(op: string, id: string, asJson?: boolean): never {
  const scopeCtx = getScopeContext();
  const candidates = dbListTriggers()
    .filter((trigger) => canReadTrigger(scopeCtx, trigger))
    .flatMap((trigger) => [trigger.id, trigger.name]);
  contractFail(op, "TRIGGER_NOT_FOUND", `Trigger not found: ${id}`, {
    ...{
      asJson,
      details: {
        suggestedAction: "Check the trigger id (see suggestions; list with: ravi triggers list --json)",
        suggestions: suggestSimilar(id, candidates),
      },
    },
    diagnostic: errorDiagnostic(`Trigger not found: ${id}`, { operation: op }),
  });
}

/**
 * Mutating an existing trigger the caller may not modify fails with an explicit
 * PERMISSION_DENIED (exit 1) instead of masquerading as TRIGGER_NOT_FOUND. The
 * envelope only echoes the id the caller supplied plus the missing grant.
 */
function assertTriggerMutable(op: string, id: string, trigger: Trigger, asJson?: boolean): void {
  const scopeCtx = getScopeContext();
  const ownerAgentId = triggerOwnerId(trigger);
  if (canAccessResource(scopeCtx, ownerAgentId, "mutate")) return;

  const denial = recordResourceAccessDenial({
    ctx: scopeCtx,
    resourceAgentId: ownerAgentId,
    mode: "mutate",
    resourceLabel: `trigger ${id}`,
    command: op,
  });
  contractFail(op, "PERMISSION_DENIED", denial.message, {
    ...{
      asJson,
      details: {
        suggestedAction: denial.requiredCapability
          ? `Request ${denial.requiredCapability} from an operator and retry '${op}'`
          : `Request modify authority on the owning agent from an operator and retry '${op}'`,
        ...(denial.requiredCapability ? { requiredCapability: denial.requiredCapability } : {}),
        ...(denial.denialId ? { denialId: denial.denialId } : {}),
      },
    },
    diagnostic: errorDiagnostic(denial.message, { operation: op }),
  });
}

/**
 * A trigger runs as its agent, in its session, and replies into its reply
 * session, so choosing them needs the authority to act there: mutate on the
 * agent, and modify on a literal session of another agent or on the reply
 * session. Templated sessions are confined to the trigger's agent at fire time.
 */
function assertTriggerTargetAuthorized(
  op: string,
  target: { agentId?: string; session?: string; replySession?: string | null },
  asJson?: boolean,
): void {
  assertNoUserOverlayAutomationWrite(op);
  const scopeCtx = getScopeContext();
  const owner = target.agentId ?? scopeCtx?.agentId ?? getDefaultAgentId();
  if (!canAccessResource(scopeCtx, owner, "mutate")) {
    const denial = recordResourceAccessDenial({
      ctx: scopeCtx,
      resourceAgentId: owner,
      mode: "mutate",
      resourceLabel: "trigger target agent",
      command: op,
    });
    contractFail(op, "PERMISSION_DENIED", denial.message, {
      ...{
        asJson,
        details: { ...(denial.requiredCapability ? { requiredCapability: denial.requiredCapability } : {}) },
      },
      diagnostic: errorDiagnostic(denial.message, { operation: op }),
    });
  }
  if (!isScopeEnforced(scopeCtx)) return;
  const canModify = (ref: string) => {
    const existing = resolveSession(ref);
    return [ref, existing?.name, existing?.sessionKey].some((r) => r && canModifySession(scopeCtx, r));
  };
  const literalSession = target.session?.trim();
  if (literalSession && !isLegacySessionTarget(literalSession) && !literalSession.includes("{{")) {
    const existing = resolveSession(literalSession);
    if (existing && existing.agentId !== scopeCtx?.agentId && !canModify(literalSession)) {
      contractFail(op, "PERMISSION_DENIED", `Permission denied for session target: ${literalSession}`, {
        ...{ asJson },
        diagnostic: errorDiagnostic(`Permission denied for session target: ${literalSession}`, { operation: op }),
      });
    }
  }
  const replySession = target.replySession?.trim();
  if (replySession && !canModify(replySession)) {
    contractFail(op, "PERMISSION_DENIED", `Permission denied for session target: ${replySession}`, {
      ...{ asJson },
      diagnostic: errorDiagnostic(`Permission denied for session target: ${replySession}`, { operation: op }),
    });
  }
}

/** Cooldown/debounce of 0 means the feature is off. */
function formatOptionalDurationMs(ms: number): string {
  return ms > 0 ? formatDurationMs(ms) : "off";
}

function serializeTrigger(trigger: Trigger) {
  const activation = resolveTriggerActivation(trigger);
  return {
    ...trigger,
    executionType: trigger.executionType ?? "agent",
    // Who its agent turns act as in Bases. A trigger with no recorded owner acts as nobody.
    ownerPrincipal: triggerRunsAs(trigger),
    runsAsOperator: triggerOwnerActsAsOperator(trigger.ownerPrincipal),
    // Bases lends the owner's authority only in the trigger's own session (`--session isolated`).
    ownsSession: triggerRunsInOwnSession(trigger),
    // The session an isolated trigger runs in, once it has fired.
    isolatedSessionName: triggerIsolatedSessionName(trigger.agentId ?? getDefaultAgentId(), trigger),
    filterRejectCount: trigger.filterRejectCount ?? 0,
    effectiveAgentId: trigger.agentId ?? getDefaultAgentId(),
    debounceMs: trigger.debounceMs ?? 0,
    cooldownDescription: formatOptionalDurationMs(trigger.cooldownMs),
    debounceDescription: formatOptionalDurationMs(trigger.debounceMs ?? 0),
    shellTimeoutDescription:
      (trigger.executionType ?? "agent") === "shell"
        ? formatDurationMs(trigger.shellTimeoutMs ?? DEFAULT_CRON_SHELL_TIMEOUT_MS)
        : undefined,
    filterStatus: activation.filterStatus,
    ...(activation.filterStatus === "invalid" ? { filterError: activation.filter.error ?? "Invalid filter" } : {}),
    runtimeState: activation.state,
    ...(activation.reason ? { runtimeStateReason: activation.reason } : {}),
  };
}

/**
 * The `Session` line. For an agent trigger a person owns, says when it runs
 * in a session anyone can name, where Bases does not lend the owner's
 * authority. A trigger nobody owns is refused everywhere, which `Runs as`
 * already says.
 */
function describeSession(
  trigger: Pick<Trigger, "id" | "agentId" | "session" | "ownerPrincipal" | "executionType">,
): string {
  // Show the isolated session's name once it exists, so its owner can read it.
  const isolatedName = triggerIsolatedSessionName(trigger.agentId ?? getDefaultAgentId(), trigger);
  if (isolatedName) return `${trigger.session} (${isolatedName})`;
  const couldLend = (trigger.executionType ?? "agent") === "agent" && isPersonPrincipal(trigger.ownerPrincipal);
  return couldLend && !triggerRunsInOwnSession(trigger)
    ? `${trigger.session} (not the trigger's own session: its turns cannot use Bases; isolated can)`
    : trigger.session;
}

/**
 * The `Runs as` line. A shell trigger runs only when its owner acts as the
 * operator; the runner turns it off otherwise.
 */
function describeRunsAs(trigger: Pick<Trigger, "ownerPrincipal" | "executionType">): string {
  const owner = triggerRunsAs(trigger);
  if (triggerOwnerActsAsOperator(trigger.ownerPrincipal)) return owner;
  if ((trigger.executionType ?? "agent") === "shell")
    return `${owner} (not the operator: a shell trigger does not run)`;
  return `${owner} (not the operator)`;
}

function invalidFilterWarning(
  trigger: Pick<Trigger, "id" | "enabled" | "topic" | "filter" | "agentId">,
): string | undefined {
  const activation = resolveTriggerActivation(trigger);
  if (activation.state === "unbound_agent") {
    return `Trigger ${trigger.id} is bound to missing agent ${trigger.agentId ?? "(unknown)"} (unbound_agent) and will not fire or create a session.`;
  }
  if (activation.state !== "invalid_filter") return undefined;
  return `Trigger ${trigger.id} has an invalid filter (${activation.filter.error ?? "unknown error"}) and will not fire. Fix it with: ravi triggers set ${trigger.id} filter '<expression>' (or clear it with: ravi triggers set ${trigger.id} filter -)`;
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

function printWarnings(warnings: string[]): void {
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
  const session = trimmed.slice(prefix.length).trim();
  // Said now, so a failure is not silently reported nowhere later.
  const refused = triggerSessionTargetError(session);
  if (refused) fail(refused);
  return `${prefix}${session}`;
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

    // Scope isolation: own triggers plus those of agents the caller can view
    const scopeCtx = getScopeContext();
    if (isScopeEnforced(scopeCtx)) {
      triggers = triggers.filter((t) => canReadTrigger(scopeCtx, t));
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
    const warnings = triggers.map(invalidFilterWarning).filter((warning): warning is string => Boolean(warning));
    const payload = {
      total: page.total,
      pagination,
      ...(tagFilter ? { filters: { tag: tagFilter } } : {}),
      items: serializedTriggers,
      triggers: serializedTriggers,
      ...(warnings.length ? { warnings } : {}),
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
      console.log(
        "  ID        NAME                      ENABLED  STATE           TOPIC                           FIRES",
      );
      console.log(
        "  --------  ------------------------  -------  --------------  ------------------------------  -----",
      );

      for (const t of pageTriggers) {
        const id = t.id.padEnd(8);
        const name = t.name.slice(0, 24).padEnd(24);
        const enabled = (t.enabled ? "yes" : "no").padEnd(7);
        const state = resolveTriggerActivation(t).state.padEnd(14);
        const topic = t.topic.slice(0, 30).padEnd(30);
        const fires = String(t.fireCount);

        console.log(`  ${id}  ${name}  ${enabled}  ${state}  ${topic}  ${fires}`);
      }

      console.log(
        `\n  Total: ${page.total} triggers (${pageTriggers.length} returned, limit ${page.limit}, offset ${page.offset})`,
      );
      if (warnings.length) {
        console.log("");
        printWarnings(warnings);
      }
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
    // Lookups stay enumeration-resistant: an unauthorized existing trigger
    // looks exactly like a missing one (permissions/resource-visibility).
    const trigger = dbGetTrigger(id);
    if (!trigger || !canReadTrigger(getScopeContext(), trigger)) {
      failTriggerNotFound("triggers show", id, asJson);
    }

    const serialized = serializeTrigger(trigger);
    const payload = { trigger: serialized };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`\nTrigger: ${trigger.name}\n`);
      console.log(`  ID:              ${trigger.id}`);
      console.log(`  Agent:           ${trigger.agentId ?? "(default)"}`);
      console.log(`  Account:         ${trigger.accountId ?? "(auto)"}`);
      console.log(`  Enabled:         ${trigger.enabled ? "yes" : "no"}`);
      console.log(`  State:           ${serialized.runtimeState}`);
      if (serialized.runtimeStateReason) {
        console.log(`  State reason:    ${serialized.runtimeStateReason}`);
      }
      console.log(`  Topic:           ${trigger.topic}`);
      console.log(`  Execution:       ${trigger.executionType ?? "agent"}`);
      console.log(`  Runs as:         ${describeRunsAs(trigger)}`);
      if ((trigger.executionType ?? "agent") === "shell") {
        console.log(`  Shell:           ${trigger.shellCommand ?? "(missing)"}`);
        console.log(`  Timeout:         ${formatDurationMs(trigger.shellTimeoutMs ?? DEFAULT_CRON_SHELL_TIMEOUT_MS)}`);
        if (trigger.shellEnvFile) console.log(`  Env file:        ${trigger.shellEnvFile}`);
        if (trigger.onError) console.log(`  On error:        ${trigger.onError}`);
      }
      console.log(`  Session:         ${describeSession(trigger)}`);
      if (trigger.replySession) {
        console.log(`  Reply session:   ${trigger.replySession}`);
      }
      console.log(`  Cooldown:        ${formatOptionalDurationMs(trigger.cooldownMs)}`);
      console.log(`  Debounce:        ${formatOptionalDurationMs(trigger.debounceMs ?? 0)}`);
      if (trigger.filter) {
        console.log(`  Filter:          ${trigger.filter}`);
      }
      if (serialized.filterError) {
        console.log(`  Filter error:    ${serialized.filterError}`);
        console.log(`  Fix:             ravi triggers set ${trigger.id} filter '<expression>'  (clear: filter -)`);
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
      if (trigger.filter) {
        console.log(`  Filter rejects:  ${trigger.filterRejectCount ?? 0}`);
        if (trigger.lastFilterRejectAt) {
          console.log(`  Last reject:     ${new Date(trigger.lastFilterRejectAt).toLocaleString()}`);
        }
        if (trigger.fireCount === 0 && (trigger.filterRejectCount ?? 0) > 0) {
          console.log(
            `  Hint:            events arrive on this topic but the filter rejects all of them; check the field paths against a real event (daemon log shows its top-level keys)`,
          );
        }
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
      description:
        "Minimum gap between fires; events inside it are dropped (e.g., 30s, 1m; off to disable). Default: 5s",
    })
    cooldown?: string,
    @Option({
      flags: "--session <name>",
      description:
        "Session to run in, by name; may be a template resolved per event (e.g. issue-{{data.payload.row.values.topic_id.0}}) for one session per value; an event whose name does not resolve is skipped, never sent to another session. Created when missing. Default: the current session, or the agent main session outside one. The reserved values main and isolated keep their old meaning (the agent main session; one session per trigger)",
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
    @Option({
      flags: "--debounce <duration>",
      description:
        "Batch a burst of events into one fire, this long after the last event, carrying every event (e.g., 2s, 1m). Default: off",
    })
    debounce?: string,
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
    if (isShellTrigger) {
      assertShellAutomationAuthorized("triggers add");
      assertShellTriggerChange("triggers add", null, asJson);
      assertShellEnvFileAllowed("triggers add", envFile, asJson);
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

    // Parse cooldown and debounce (`off` disables either)
    let cooldownMs = 5000;
    if (cooldown) {
      try {
        cooldownMs = parseOptionalDurationMs(cooldown, parseDurationMs);
      } catch (err) {
        fail(`Invalid cooldown: ${err instanceof Error ? err.message : err}`);
      }
    }
    let debounceMs = 0;
    if (debounce) {
      try {
        debounceMs = parseOptionalDurationMs(debounce, parseDurationMs);
      } catch (err) {
        fail(`Invalid debounce: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Resolve agent: explicit flag > caller agent (from session context)
    const ctx = getContext();

    // Session: explicit name/template, else the caller's current session.
    // Outside a session there is no current one; the agent main session is it.
    if (session !== undefined) {
      const error = sessionTargetError(session) ?? triggerSessionTargetError(session);
      if (error) fail(error);
    }
    // A trigger's own session takes that trigger's fires only, so a trigger
    // created during one of its turns has no current session to default to.
    const currentSession = isTriggerOwnSessionKey(ctx?.sessionKey) ? undefined : ctx?.sessionName || ctx?.sessionKey;
    const sessionTarget: SessionTarget = session?.trim() || currentSession || "main";
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
    assertTriggerTargetAuthorized(
      "triggers add",
      {
        ...(agent ? { agentId: agent } : {}),
        ...(session !== undefined ? { session: sessionTarget } : {}),
        ...(replySessionOverride?.trim() ? { replySession } : {}),
      },
      asJson,
    );

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
      debounceMs,
      filter,
      ownerPrincipal: resolveTriggerOwnerForCurrentTurn(),
    };

    try {
      const trigger = dbCreateTrigger(input);

      await nats.emit("ravi.triggers.refresh", {});
      const runsAsWarning = triggerRunsAsWarning(trigger);
      const addWarnings = [...topicWarnings, ...(runsAsWarning ? [runsAsWarning] : [])];

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
        ...(addWarnings.length ? { warnings: addWarnings } : {}),
      };
      if (asJson) {
        printJson(payload);
      } else {
        printWarnings(addWarnings);
        console.log(`\n✓ Created trigger: ${trigger.id}`);
        console.log(`  Name:       ${trigger.name}`);
        console.log(`  Topic:      ${trigger.topic}`);
        if (resolvedMessage.source === "catalog_default") {
          console.log(`  Message:    catalog default (${resolvedMessage.templateId})`);
        }
        console.log(`  Cooldown:   ${formatOptionalDurationMs(trigger.cooldownMs)}`);
        if (trigger.debounceMs) console.log(`  Debounce:   ${formatOptionalDurationMs(trigger.debounceMs)}`);
        console.log(`  Session:    ${describeSession(trigger)}`);
        console.log(`  Runs as:    ${describeRunsAs(trigger)}`);
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
    if (!trigger) failTriggerNotFound("triggers enable", id, asJson);
    assertTriggerMutable("triggers enable", id, trigger, asJson);
    if ((trigger.executionType ?? "agent") === "shell") assertShellTriggerChange("triggers enable", trigger, asJson);
    assertNoUserOverlayAutomationWrite("triggers enable");

    try {
      // Arming a trigger is its owner's call, or the operator's (it then still
      // acts as its owner): turned on by anyone else, it runs with no owner.
      const keepOwnerFor = ownerKeptOnEnable(trigger);
      const updated = dbUpdateTrigger(id, { enabled: true }, keepOwnerFor ? { keepOwnerFor } : {});
      await nats.emit("ravi.triggers.refresh", {});
      const warnings = [invalidFilterWarning(updated), triggerOwnerLostWarning(trigger, updated)].filter(
        (warning): warning is string => Boolean(warning),
      );
      const payload = {
        status: "enabled" as const,
        target: { type: "trigger" as const, id },
        changedCount: 1,
        trigger: serializeTrigger(updated),
        ...(warnings.length ? { warnings } : {}),
      };
      if (asJson) {
        printJson(payload);
      } else {
        console.log(`✓ Enabled trigger: ${id} (${trigger.name})`);
        printWarnings(warnings);
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
    if (!trigger) failTriggerNotFound("triggers disable", id, asJson);
    assertTriggerMutable("triggers disable", id, trigger, asJson);
    if ((trigger.executionType ?? "agent") === "shell") assertShellTriggerChange("triggers disable", trigger, asJson);

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
        "Property: name, message, shell, exec, timeout, env-file, on-error, topic, agent, account, session, cooldown, debounce, filter, replySession",
    })
    key: string,
    @Arg("value", { description: "Property value" }) value: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const trigger = dbGetTrigger(id);
    if (!trigger) failTriggerNotFound("triggers set", id, asJson);
    assertTriggerMutable("triggers set", id, trigger, asJson);
    // Every edit (message, filter, topic...) changes what runs later as the agent.
    assertNoUserOverlayAutomationWrite("triggers set");
    const clearing = value === "null" || value === "-";
    if (key === "shell" || key === "exec" || key === "env-file") assertShellAutomationAuthorized("triggers set");
    if (key === "agent") {
      assertTriggerTargetAuthorized("triggers set", { agentId: clearing ? getDefaultAgentId() : value }, asJson);
    } else if (key === "session") {
      assertTriggerTargetAuthorized("triggers set", { agentId: triggerOwnerId(trigger), session: value }, asJson);
    } else if (key === "replySession" && !clearing) {
      assertTriggerTargetAuthorized("triggers set", { agentId: triggerOwnerId(trigger), replySession: value }, asJson);
    }

    // Any edit of a shell trigger, and turning a trigger into one, is its
    // owner's (the operator's) to make. Checked before the edit so the refusal
    // keeps its code.
    if (key === "shell" || key === "exec" || (trigger.executionType ?? "agent") === "shell") {
      assertShellTriggerChange("triggers set", trigger, asJson);
      if (key === "env-file" && value !== "null" && value !== "-") {
        assertShellEnvFileAllowed("triggers set", value, asJson);
      }
    }

    // The trigger keeps its owner only when the owner makes this change;
    // anyone else leaves it with none, in the same write as the edit.
    const keepOwnerFor = TRIGGER_OWNER_NEUTRAL_SET_KEYS.has(key) ? undefined : resolveTriggerOwnerForCurrentTurn();

    try {
      let updated: Trigger | null = null;
      let normalizedValue: unknown = value;
      let warnings: string[] = [];
      const logHuman = (message: string) => {
        if (!asJson) console.log(message);
      };
      const update = (updates: Parameters<typeof dbUpdateTrigger>[1]) =>
        dbUpdateTrigger(id, updates, keepOwnerFor ? { keepOwnerFor } : {});

      switch (key) {
        case "name":
          updated = update({ name: value });
          logHuman(`✓ Name set: ${id} -> ${value}`);
          break;

        case "message":
          updated = update({
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
          updated = update({
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
          updated = update({ shellTimeoutMs });
          normalizedValue = shellTimeoutMs;
          logHuman(`✓ Shell timeout set: ${id} -> ${shellTimeoutMs ? formatDurationMs(shellTimeoutMs) : "(default)"}`);
          break;
        }

        case "env-file": {
          if ((trigger.executionType ?? "agent") !== "shell") {
            fail("env-file only applies to shell triggers");
          }
          const shellEnvFile = value === "null" || value === "-" ? null : value;
          updated = update({ shellEnvFile });
          normalizedValue = shellEnvFile;
          logHuman(`✓ Shell env file set: ${id} -> ${shellEnvFile ?? "(none)"}`);
          break;
        }

        case "on-error": {
          if ((trigger.executionType ?? "agent") !== "shell") {
            fail("on-error only applies to shell triggers");
          }
          const normalizedOnError = normalizeTriggerOnError(value);
          updated = update({ onError: normalizedOnError ?? null });
          normalizedValue = normalizedOnError ?? null;
          logHuman(`✓ Shell on-error set: ${id} -> ${normalizedOnError ?? "(none)"}`);
          break;
        }

        case "topic": {
          warnings = getTriggerTopicWarnings(value);
          updated = update({ topic: value });
          if (!asJson) printWarnings(warnings);
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
          updated = update({ agentId });
          normalizedValue = agentId ?? null;
          logHuman(`✓ Agent set: ${id} -> ${agentId ?? "(default)"}`);
          break;
        }

        case "account": {
          const accountId = value === "null" || value === "-" ? undefined : value;
          updated = update({ accountId });
          normalizedValue = accountId ?? null;
          logHuman(`✓ Account set: ${id} -> ${accountId ?? "(auto)"}`);
          break;
        }

        case "session": {
          const error = sessionTargetError(value) ?? triggerSessionTargetError(value);
          if (error) fail(error);
          const session = value.trim();
          updated = update({ session });
          normalizedValue = session;
          logHuman(`✓ Session set: ${id} -> ${session}`);
          break;
        }

        case "cooldown": {
          const ms = parseOptionalDurationMs(value, parseDurationMs);
          updated = update({ cooldownMs: ms });
          normalizedValue = ms;
          logHuman(`✓ Cooldown set: ${id} -> ${formatOptionalDurationMs(ms)}`);
          break;
        }

        case "debounce": {
          const ms = parseOptionalDurationMs(value, parseDurationMs);
          updated = update({ debounceMs: ms });
          normalizedValue = ms;
          logHuman(`✓ Debounce set: ${id} -> ${formatOptionalDurationMs(ms)}`);
          break;
        }

        case "filter": {
          const filterValue = value === "null" || value === "-" ? null : value;
          assertValidTriggerFilter(filterValue ?? undefined);
          updated = update({ filter: filterValue });
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
          updated = update({ replySession });
          normalizedValue = replySession;
          logHuman(`✓ Reply session set: ${id} -> ${replySession ?? "(none)"}`);
          break;
        }

        default:
          fail(
            `Unknown property: ${key}. Valid: name, message, shell, exec, timeout, env-file, on-error, topic, agent, account, session, cooldown, debounce, filter, replySession`,
          );
      }

      await nats.emit("ravi.triggers.refresh", {});
      const current = updated ?? dbGetTrigger(id);
      // Said when this edit took the owner away.
      const ownerWarning = current ? triggerOwnerLostWarning(trigger, current) : null;
      if (ownerWarning) {
        warnings = [...warnings, ownerWarning];
        if (!asJson) printWarnings([ownerWarning]);
      }
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
    if (!trigger) failTriggerNotFound("triggers test", id, asJson);
    assertTriggerMutable("triggers test", id, trigger, asJson);
    assertNoUserOverlayAutomationWrite("triggers test");

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
      // The test fire acts as the trigger's owner only when the owner asked for it.
      await nats.emit("ravi.triggers.test", { triggerId: id, initiator: resolveTriggerOwnerForCurrentTurn() });
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
    if (!trigger) failTriggerNotFound("triggers rm", id, asJson);
    assertTriggerMutable("triggers rm", id, trigger, asJson);

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
