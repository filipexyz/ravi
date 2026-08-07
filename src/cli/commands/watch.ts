import "reflect-metadata";
import { Arg, CliOnly, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import {
  ContractError,
  contractDryRun,
  contractFail,
  expectedErrorToContractError,
  pickFields,
  suggestSimilar,
} from "../agent-contract.js";
import { fail, getContext } from "../context.js";
import { buildCliOffsetPagination } from "../pagination.js";
import {
  watchConnectorsReturnSchema,
  watchCreateReturnSchema,
  watchEventsReturnSchema,
  watchListReturnSchema,
  watchMutationReturnSchema,
  watchRemoveReturnSchema,
  watchShowReturnSchema,
  watchTriggerReturnSchema,
} from "./operational-return-schemas.js";
import { getAgent } from "../../router/config.js";
import { getAccountForAgent } from "../../router/router-db.js";
import { parseDurationMs, formatDurationMs } from "../../cron/schedule.js";
import { dbCreateTrigger, type TriggerInput } from "../../triggers/index.js";
import {
  createWatch,
  isWatchApiError,
  listWatchConnectors,
  listWatchRecords,
  removeWatch,
  setWatchEnabled,
  showWatch,
  type WatchConnectorDefinition,
  type WatchRecord,
} from "../../watch/index.js";

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

// ============================================================
// Manual v2 contract helpers (error envelope + suggestions).
// Text mode keeps the legacy `fail()` behavior; `--json` emits the
// {success:false, error:{code, ...suggestions}} envelope. Exit taxonomy:
// 1 not-found/provider · 2 usage · 3 policy (write brake / dry-run).
// ============================================================

/**
 * Watch ids are public through `watch list`, so WATCH_NOT_FOUND enriches the
 * envelope with real similar ids/names/resources from the local store.
 */
function failWatchNotFound(op: string, watchId: string, asJson?: boolean): never {
  const candidates = listWatchRecords({ limit: 40 }).items.flatMap((watch) => [
    watch.id,
    watch.name,
    watch.resourceRef,
  ]);
  contractFail(op, "WATCH_NOT_FOUND", `Watch not found: ${watchId}`, {
    asJson,
    details: {
      suggestedAction: "Check the watch id (see suggestions; list with: ravi watch list --json)",
      suggestions: suggestSimilar(watchId, candidates),
    },
  });
}

/** Resolve a watch or fail with the contract envelope (exit 1). */
function requireWatch(op: string, watchId: string, asJson?: boolean): WatchRecord {
  const watch = showWatch(watchId);
  if (!watch) failWatchNotFound(op, watchId, asJson);
  return watch;
}

@Group({
  name: "watch",
  description: "Create watches and wire their events to triggers",
  scope: "open",
})
export class WatchCommands {
  @Command({ name: "connectors", description: "List available watch connectors and event types" })
  @CommandAccess({ kind: "read", resource: "watch", action: "connectors", risk: "low" })
  @Returns(watchConnectorsReturnSchema)
  connectors(
    @Option({ flags: "--provider <provider>", description: "Filter by provider id" }) provider?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const connectors = listWatchConnectors(provider);
    const payload = { total: connectors.length, connectors, items: connectors };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    if (connectors.length === 0) {
      console.log("No watch connectors found.");
      return payload;
    }
    console.log("\nWatch connectors:\n");
    for (const connector of connectors) printConnector(connector);
    return payload;
  }

  @Command({ name: "create", description: "Create a watch" })
  @CommandAccess({ kind: "mutate", resource: "watch", action: "create", risk: "medium" })
  @Returns(watchCreateReturnSchema)
  async create(
    @Arg("provider", { description: "Connector id: github or npm" }) provider: string,
    @Arg("resource", { description: "Watched resource, e.g. owner/repo or npm package" }) resource: string,
    @Option({ flags: "--event <event>", description: "Event type; comma-separated for multiple" }) event?: string,
    @Option({ flags: "--placement <placement>", description: "auto|local|console (default: auto)" }) placement?: string,
    @Option({ flags: "--name <name>", description: "Human name for this watch" }) name?: string,
    @Option({ flags: "--installation <id>", description: "Console provider installation id" }) installationId?: string,
    @Option({ flags: "--resource-id <id>", description: "Console provider resource id" }) providerResourceId?: string,
    @Option({ flags: "--project <id>", description: "Console project id" }) projectId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runWatchCommand("watch create", asJson, async () => {
      const result = await createWatch({
        provider,
        resourceRef: resource,
        placement: parsePlacement(placement),
        name,
        eventTypes: parseEventTypes(event),
        providerInstallationId: installationId,
        providerResourceId,
        projectId,
      });
      const payload = {
        status: result.createdRemote ? "created_remote" : "created_local",
        watch: serializeWatch(result.watch),
        capabilities: result.capabilities,
        next: {
          trigger: `ravi watch trigger ${result.watch.id} --message ${JSON.stringify("Descreva o evento e diga se precisamos agir.")} --execute`,
          disable: `ravi watch disable ${result.watch.id}`,
        },
      };
      if (asJson) {
        printJson(payload);
        return payload;
      }
      console.log(`\nCreated watch: ${result.watch.id}`);
      printWatchSummary(result.watch);
      console.log("\nTrigger topic(s):");
      for (const subject of result.watch.eventSubjects) console.log(`  ${subject}`);
      console.log("\nNext:");
      console.log(
        `  ravi watch trigger ${result.watch.id} --message "Descreva o evento e diga se precisamos agir." --execute`,
      );
      return payload;
    });
  }

  @Command({ name: "list", description: "List watches" })
  @CommandAccess({ kind: "read", resource: "watch", action: "list", risk: "low" })
  @Returns(watchListReturnSchema)
  list(
    @Option({ flags: "--provider <provider>", description: "Filter by provider" }) provider?: string,
    @Option({ flags: "--status <status>", description: "active|disabled|error|all" }) status?: string,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of watches to skip" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--fields <a,b,c>", description: "Compact mode: keep only these fields of each item" })
    fields?: string,
  ) {
    const page = listWatchRecords({
      provider: provider?.trim() || null,
      status: parseStatus(status),
      limit: parsePositiveInt(limit, 50, 500),
      offset: parsePositiveInt(offset, 0, Number.MAX_SAFE_INTEGER),
    });
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "watch", "list"],
      limit: page.limit,
      offset: page.offset,
      returned: page.items.length,
      total: page.total,
      options: ["--provider", provider?.trim() || null, "--status", status?.trim() || null],
    });
    const projectedWatches = pickFields(page.items.map(serializeWatch), fields);
    const payload = {
      total: page.total,
      pagination,
      items: projectedWatches,
      watches: projectedWatches,
    };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    if (page.items.length === 0) {
      console.log("No watches configured.");
      console.log("Usage: ravi watch create github owner/repo --event push.default_branch");
      return payload;
    }
    console.log(`\nWatches (${page.items.length} returned of ${page.total}):\n`);
    for (const watch of page.items) {
      console.log(`  ${watch.id}  ${watch.provider}  ${watch.status}  ${watch.placement}  ${watch.resourceRef}`);
    }
    if (pagination.nextCommand) {
      console.log("\nNext page:");
      console.log(`  ${pagination.nextCommand}`);
    }
    return payload;
  }

  @Command({ name: "show", description: "Show watch details" })
  @CommandAccess({ kind: "read", resource: "watch", action: "show", risk: "low" })
  @Returns(watchShowReturnSchema)
  show(
    @Arg("id", { description: "Watch id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const watch = requireWatch("watch show", id, asJson);
    const payload = { watch: serializeWatch(watch) };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    printWatchSummary(watch);
    return payload;
  }

  @Command({ name: "enable", description: "Enable a watch" })
  @CommandAccess({ kind: "mutate", resource: "watch", action: "enable", risk: "medium" })
  @Returns(watchMutationReturnSchema)
  async enable(
    @Arg("id", { description: "Watch id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    requireWatch("watch enable", id, asJson);
    return runWatchCommand("watch enable", asJson, async () => {
      const watch = await setWatchEnabled(id, true);
      const payload = { status: "enabled", watch: serializeWatch(watch) };
      if (asJson) printJson(payload);
      else console.log(`Enabled watch ${id}.`);
      return payload;
    });
  }

  @Command({ name: "disable", description: "Disable a watch" })
  @CommandAccess({ kind: "mutate", resource: "watch", action: "disable", risk: "medium" })
  @Returns(watchMutationReturnSchema)
  async disable(
    @Arg("id", { description: "Watch id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    requireWatch("watch disable", id, asJson);
    return runWatchCommand("watch disable", asJson, async () => {
      const watch = await setWatchEnabled(id, false);
      const payload = { status: "disabled", watch: serializeWatch(watch) };
      if (asJson) printJson(payload);
      else console.log(`Disabled watch ${id}.`);
      return payload;
    });
  }

  @Command({ name: "rm", description: "Remove a watch" })
  @CommandAccess({ kind: "mutate", resource: "watch", action: "rm", risk: "destructive", requiresConfirmation: true })
  @Returns(watchRemoveReturnSchema)
  async rm(
    @Arg("id", { description: "Watch id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually remove the watch; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    const watch = requireWatch("watch rm", id, asJson);
    if (execute !== true) {
      // Write brake (Manual v2 7.8): removing a watch is destructive (console
      // watches are also deleted remotely), so dry-run by default and exit 3
      // before any local or remote deletion.
      contractDryRun(
        "watch rm",
        {
          watchId: watch.id,
          provider: watch.provider,
          resourceRef: watch.resourceRef,
          placement: watch.placement,
          status: watch.status,
          ...(watch.name ? { name: watch.name } : {}),
        },
        { asJson },
      );
    }
    return runWatchCommand("watch rm", asJson, async () => {
      const deleted = await removeWatch(id);
      if (!deleted) failWatchNotFound("watch rm", id, asJson);
      const payload = { deleted, id };
      if (asJson) printJson(payload);
      else console.log(`Removed watch ${id}.`);
      return payload;
    });
  }

  @Command({ name: "events", description: "Show trigger-ready event subjects for a watch" })
  @CommandAccess({ kind: "read", resource: "watch", action: "events", risk: "low" })
  @Returns(watchEventsReturnSchema)
  events(
    @Arg("id", { description: "Watch id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const watch = requireWatch("watch events", id, asJson);
    const payload = {
      watchId: watch.id,
      eventTypes: watch.eventTypes,
      subjects: watch.eventSubjects,
    };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`Watch ${watch.id} subjects:`);
    for (const subject of watch.eventSubjects) console.log(`  ${subject}`);
    return payload;
  }

  @Command({ name: "trigger", description: "Create a trigger for a watch event in the current chat" })
  @CommandAccess({ kind: "mutate", resource: "watch", action: "trigger", risk: "high", requiresConfirmation: true })
  @Returns(watchTriggerReturnSchema)
  async trigger(
    @Arg("id", { description: "Watch id" }) id: string,
    @Option({ flags: "--message <prompt>", description: "Prompt to run when the watch fires" }) message?: string,
    @Option({ flags: "--event <event>", description: "Specific event type for multi-event watches" }) event?: string,
    @Option({ flags: "--agent <id>", description: "Agent id (default: current/default agent)" }) agent?: string,
    @Option({ flags: "--account <name>", description: "Outbound account id" }) account?: string,
    @Option({ flags: "--session <type>", description: "main or isolated (default: isolated)" }) session?: string,
    @Option({ flags: "--cooldown <duration>", description: "Cooldown between fires (default: 5s)" }) cooldown?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually create the trigger; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    return runWatchCommand("watch trigger", asJson, async () => {
      if (!message?.trim()) fail("--message is required");
      const watch = requireWatch("watch trigger", id, asJson);
      const eventType = event?.trim() || watch.eventTypes[0];
      if (!eventType) fail(`Watch ${id} has no event type configured`);
      const subject = watch.eventSubjects.find((item) => item.endsWith(`.${eventType}`)) ?? watch.eventSubjects[0];
      if (!subject) fail(`Watch ${id} has no trigger subject configured`);

      if (agent && !getAgent(agent)) fail(`Agent not found: ${agent}`);
      const ctx = getContext();
      const resolvedAgent = agent ?? ctx?.agentId;
      const resolvedAccount =
        account ?? ctx?.source?.accountId ?? (resolvedAgent ? getAccountForAgent(resolvedAgent) : undefined);
      const replySource =
        ctx?.source?.channel && ctx.source.accountId && ctx.source.chatId
          ? {
              channel: ctx.source.channel,
              accountId: ctx.source.accountId,
              chatId: ctx.source.chatId,
              ...(ctx.source.threadId ? { threadId: ctx.source.threadId } : {}),
            }
          : undefined;

      const input: TriggerInput = {
        name: `watch:${watch.provider}:${eventType}`,
        topic: subject,
        message,
        agentId: resolvedAgent,
        accountId: resolvedAccount,
        replySession: ctx?.sessionName ?? ctx?.sessionKey,
        replySource,
        session: parseSession(session),
        cooldownMs: cooldown ? parseDurationMs(cooldown) : 5000,
        filter: `data.watchId == ${JSON.stringify(watch.id)}`,
      };
      if (execute !== true) {
        // Write brake (Manual v2 7.8): this arms a real automation — every
        // future watch event will fire a prompt at an agent session. Dry-run
        // by default and exit 3 before dbCreateTrigger, showing the resolved
        // watch and the exact trigger that would be created.
        contractDryRun(
          "watch trigger",
          {
            watch: {
              id: watch.id,
              provider: watch.provider,
              resourceRef: watch.resourceRef,
              placement: watch.placement,
              status: watch.status,
            },
            trigger: {
              name: input.name,
              topic: input.topic,
              filter: input.filter,
              message: input.message,
              agentId: input.agentId ?? null,
              accountId: input.accountId ?? null,
              session: input.session,
              cooldownMs: input.cooldownMs,
            },
          },
          { asJson },
        );
      }
      const trigger = dbCreateTrigger(input);
      const payload = {
        status: "created",
        watch: serializeWatch(watch),
        trigger,
      };
      if (asJson) {
        printJson(payload);
        return payload;
      }
      console.log(`Created trigger ${trigger.id} for watch ${watch.id}.`);
      console.log(`  Topic: ${trigger.topic}`);
      console.log(`  Filter: ${trigger.filter}`);
      console.log(`  Cooldown: ${formatDurationMs(trigger.cooldownMs)}`);
      return payload;
    });
  }

  @Command({ name: "run", description: "Run a local watch once (debug)" })
  @CommandAccess({ kind: "mutate", resource: "watch", action: "run", risk: "high", input: ["id"], requiresConfirmation: true })
  @CliOnly()
  run(
    @Arg("id", { description: "Watch id" }) id: string,
    @Option({ flags: "--once", description: "Run one cycle and exit" }) _once?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually run the watch cycle; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    const watch = requireWatch("watch run", id, asJson);
    if (watch.placement !== "local") fail("Only local watches can be run from the OSS CLI.");
    if (execute !== true) {
      // Write brake (Manual v2 7.8): a run cycle polls the provider and can
      // emit real watch events (firing whatever triggers are wired to them),
      // so dry-run by default and exit 3 before any polling starts.
      contractDryRun(
        "watch run",
        {
          watchId: watch.id,
          provider: watch.provider,
          resourceRef: watch.resourceRef,
          placement: watch.placement,
          eventTypes: watch.eventTypes,
          once: true,
        },
        { asJson },
      );
    }
    contractFail("watch run", "LOCAL_RUNNER_NOT_IMPLEMENTED", "Local watch polling runner is not implemented.", {
      asJson,
      details: {
        retryable: false,
        suggestedAction: "Run the watch through a supported Console placement or wait for local runner support",
      },
    });
  }
}

function parseEventTypes(value: string | undefined): string[] | undefined {
  if (!value?.trim()) return undefined;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePlacement(value: string | undefined): "auto" | "local" | "console" | undefined {
  if (!value?.trim()) return undefined;
  if (value === "auto" || value === "local" || value === "console") return value;
  fail("--placement must be auto, local, or console");
}

function parseStatus(value: string | undefined): "active" | "disabled" | "error" | "all" | null {
  if (!value?.trim()) return null;
  if (value === "active" || value === "disabled" || value === "error" || value === "all") return value;
  fail("--status must be active, disabled, error, or all");
}

function parseSession(value: string | undefined): "main" | "isolated" {
  if (!value) return "isolated";
  if (value === "main" || value === "isolated") return value;
  fail("--session must be main or isolated");
}

function parsePositiveInt(value: string | undefined, fallback: number, max: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) fail("List pagination values must be non-negative integers.");
  return Math.min(parsed, max);
}

function serializeWatch(watch: WatchRecord) {
  return {
    ...watch,
    createdAtIso: new Date(watch.createdAt).toISOString(),
    updatedAtIso: new Date(watch.updatedAt).toISOString(),
  };
}

function printConnector(connector: WatchConnectorDefinition): void {
  console.log(`- ${connector.id}: ${connector.label}`);
  console.log(`  ${connector.description}`);
  console.log(`  placements: ${connector.placements.join(", ")} (default ${connector.defaultPlacement})`);
  console.log("  events:");
  for (const eventType of connector.eventTypes) {
    const support = [
      eventType.consoleSupport ? `console:${eventType.consoleSupport}` : null,
      eventType.localSupport ? `local:${eventType.localSupport}` : null,
    ].filter(Boolean);
    console.log(
      `    - ${eventType.eventType} (${eventType.fidelity}, recommended ${eventType.recommendedPlacement}${
        support.length ? `, ${support.join(", ")}` : ""
      })`,
    );
  }
  console.log("");
}

function printWatchSummary(watch: WatchRecord): void {
  console.log(`Watch ${watch.id}`);
  console.log(`  Name:       ${watch.name ?? "(none)"}`);
  console.log(`  Provider:   ${watch.provider}`);
  console.log(`  Resource:   ${watch.resourceRef}`);
  console.log(`  Placement:  ${watch.placement}`);
  console.log(`  Status:     ${watch.status}`);
  console.log(`  Events:     ${watch.eventTypes.join(", ") || "(none)"}`);
  console.log(`  Subjects:`);
  for (const subject of watch.eventSubjects) console.log(`    - ${subject}`);
}

async function runWatchCommand<T>(
  op: string,
  asJson: boolean | undefined,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    // Contract errors (not-found envelope / write brake) are already rendered
    // and carry their own exit code (1/3) — never remap them, or the brake
    // taxonomy would be silently defeated.
    if (error instanceof ContractError) throw error;
    const expected = expectedErrorToContractError(op, error);
    if (expected) {
      contractFail(op, expected.code, expected.message, {
        asJson,
        exitCode: expected.exitCode,
        details: expected.details,
      });
    }
    if (isWatchApiError(error)) {
      const details = safeWatchErrorDetails(error.details);
      const hint = actionableHint({ code: error.code, details });
      contractFail(op, error.code, `Watch provider request failed (${error.code}).`, {
        asJson,
        details: {
          ...details,
          retryable: isRetryableWatchError(error.code),
          suggestedAction: hint ?? "Inspect the watch provider configuration and retry",
        },
      });
    }
    contractFail(op, "UNHANDLED_ERROR", "Command failed unexpectedly.", {
      asJson,
      details: {
        retryable: false,
        suggestedAction: "Inspect redacted runtime logs and retry when the underlying cause is resolved",
      },
    });
  }
}

function safeWatchErrorDetails(details: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!details) return {};
  const safe: Record<string, unknown> = {};
  for (const key of [
    "installUrl",
    "connectUrl",
    "missingPermissions",
    "missingCapabilities",
    "unsupportedEventTypes",
    "retryAfterMs",
  ]) {
    if (details[key] !== undefined) safe[key] = details[key];
  }
  return safe;
}

function isRetryableWatchError(code: string): boolean {
  return code === "RATE_LIMITED" || code === "SERVER_UNAVAILABLE" || code === "WEBHOOK_UNHEALTHY";
}

function actionableHint(error: { code: string; details?: unknown }): string | null {
  const details =
    error.details && typeof error.details === "object" ? (error.details as Record<string, unknown>) : null;
  const installUrl = typeof details?.installUrl === "string" ? details.installUrl : null;
  const connectUrl = typeof details?.connectUrl === "string" ? details.connectUrl : null;
  if (installUrl) return `Next: open ${installUrl}`;
  if (connectUrl) return `Next: open ${connectUrl}`;
  if (error.code === "AUTH_REQUIRED") return "Next: run `ravi login`.";
  return null;
}
