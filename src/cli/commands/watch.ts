import "reflect-metadata";
import { Arg, CliOnly, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
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
    return runWatchCommand(asJson, async () => {
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
          trigger: `ravi watch trigger ${result.watch.id} --message ${JSON.stringify("Descreva o evento e diga se precisamos agir.")}`,
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
      console.log(`  ravi watch trigger ${result.watch.id} --message "Descreva o evento e diga se precisamos agir."`);
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
    const payload = {
      total: page.total,
      pagination,
      items: page.items.map(serializeWatch),
      watches: page.items.map(serializeWatch),
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
    const watch = showWatch(id);
    if (!watch) fail(`Watch not found: ${id}`);
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
    return runWatchCommand(asJson, async () => {
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
    return runWatchCommand(asJson, async () => {
      const watch = await setWatchEnabled(id, false);
      const payload = { status: "disabled", watch: serializeWatch(watch) };
      if (asJson) printJson(payload);
      else console.log(`Disabled watch ${id}.`);
      return payload;
    });
  }

  @Command({ name: "rm", description: "Remove a watch" })
  @CommandAccess({ kind: "mutate", resource: "watch", action: "rm", risk: "destructive" })
  @Returns(watchRemoveReturnSchema)
  async rm(
    @Arg("id", { description: "Watch id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runWatchCommand(asJson, async () => {
      const deleted = await removeWatch(id);
      const payload = { deleted, id };
      if (asJson) printJson(payload);
      else console.log(deleted ? `Removed watch ${id}.` : `Watch not found: ${id}.`);
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
    const watch = showWatch(id);
    if (!watch) fail(`Watch not found: ${id}`);
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
  @CommandAccess({ kind: "mutate", resource: "watch", action: "trigger", risk: "high" })
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
  ) {
    return runWatchCommand(asJson, async () => {
      if (!message?.trim()) throw new Error("--message is required");
      const watch = showWatch(id);
      if (!watch) throw new Error(`Watch not found: ${id}`);
      const eventType = event?.trim() || watch.eventTypes[0];
      if (!eventType) throw new Error(`Watch ${id} has no event type configured`);
      const subject = watch.eventSubjects.find((item) => item.endsWith(`.${eventType}`)) ?? watch.eventSubjects[0];
      if (!subject) throw new Error(`Watch ${id} has no trigger subject configured`);

      if (agent && !getAgent(agent)) throw new Error(`Agent not found: ${agent}`);
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
  @CommandAccess({ kind: "mutate", resource: "watch", action: "run", risk: "high", input: ["id"] })
  @CliOnly()
  run(
    @Arg("id", { description: "Watch id" }) id: string,
    @Option({ flags: "--once", description: "Run one cycle and exit" }) _once?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const watch = showWatch(id);
    if (!watch) fail(`Watch not found: ${id}`);
    if (watch.placement !== "local") fail("Only local watches can be run from the OSS CLI.");
    const payload = {
      ok: false,
      watch: serializeWatch(watch),
      error: {
        code: "LOCAL_RUNNER_NOT_IMPLEMENTED",
        message: "Local watch polling runner is not implemented in this cut.",
      },
    };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    fail(payload.error.message);
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
  throw new Error("--session must be main or isolated");
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

async function runWatchCommand<T>(asJson: boolean | undefined, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    const payload = errorPayload(error);
    if (asJson) {
      printJson(payload);
      return undefined;
    }
    const hint = actionableHint(payload.error);
    fail(`${payload.error.code}: ${payload.error.message}${hint ? `\n${hint}` : ""}`);
  }
}

function errorPayload(error: unknown): { success: false; error: { code: string; message: string; details?: unknown } } {
  if (isWatchApiError(error)) {
    return { success: false, error: { code: error.code, message: error.message, details: error.details } };
  }
  return {
    success: false,
    error: {
      code: "WATCH_COMMAND_FAILED",
      message: error instanceof Error ? error.message : String(error),
    },
  };
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
