/**
 * Channels Commands - manage native Ravi channel runner.
 */

import "reflect-metadata";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { z } from "zod";
import {
  probeChannelRunnerHealth,
  type ChannelRunnerHealthProbeResult,
  type ChannelRunnerHealthSnapshot,
} from "../../channels/health.js";
import { ChannelRunner, runChannelRunnerFromEnv } from "../../channels/runner.js";
import { getCredentialConnection, listCredentialConnections } from "../../credentials/index.js";
import { nats } from "../../nats.js";
import {
  CHANNELS_PM2_PROCESS_NAME,
  buildPm2Env,
  getPm2Process,
  getPm2Processes,
  isPm2Available,
  isPm2ProcessRunning,
  runPm2,
} from "../../pm2.js";
import { dbGetChannel, dbListChannels, dbUpdateChannel, dbUpsertChannel } from "../../router/router-db.js";
import { contractFail, pickFields, suggestSimilar } from "../agent-contract.js";
import { Arg, CliOnly, Command, CommandAccess, Group, Option, Returns, Scope } from "../decorators.js";
import { fail } from "../context.js";
import { buildCliOffsetPagination, paginateCliItems } from "../pagination.js";
import { jsonObjectSchema, strictCliOffsetPaginationSchema } from "../return-schemas.js";
import { inspectCliRuntimeTarget, type CliRuntimeTargetSummary } from "../runtime-target.js";
import { resolveDaemonRuntimeTarget, type DaemonRuntimeTarget } from "./daemon.js";

const pm2ProcessReturnSchema = z
  .object({
    name: z.string(),
    managed: z.boolean(),
    running: z.boolean(),
    status: z.string(),
    pid: z.number().nullable(),
    pmId: z.number().nullable(),
    cpu: z.number().nullable(),
    memoryBytes: z.number().nullable(),
    memoryMb: z.number().nullable(),
  })
  .strict();

const channelAdapterHealthReturnSchema = z
  .object({
    id: z.string(),
    channelId: z.string(),
    status: z.enum(["disabled", "starting", "connected", "degraded", "reconnecting", "disconnected", "failed"]),
    reason: z.string().optional(),
    connectedAt: z.number().optional(),
    lastPongAt: z.number().optional(),
    reconnectCount: z.number().int().nonnegative().optional(),
  })
  .strict();

const channelRunnerHealthSnapshotReturnSchema = z
  .object({
    schemaVersion: z.literal(1),
    observedAt: z.number(),
    running: z.boolean(),
    startedAt: z.number().nullable(),
    pid: z.number().int().positive(),
    outbound: z
      .object({
        stream: z.string(),
        consumer: z.string(),
        enabled: z.boolean(),
        infrastructureReady: z.boolean(),
        consuming: z.boolean(),
        lastMessageAt: z.number().optional(),
        lastError: z
          .object({
            phase: z.literal("consume_loop"),
            message: z.string(),
            at: z.number(),
          })
          .strict()
          .optional(),
        publishOutbox: z
          .object({
            pendingCount: z.number().int().nonnegative(),
            oldestPendingAt: z.number().optional(),
            nextAttemptAt: z.number().optional(),
            lastPublishedAt: z.number().optional(),
            lastError: z
              .object({
                message: z.string(),
                at: z.number(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    adapters: z.array(channelAdapterHealthReturnSchema),
  })
  .strict();

const channelsHealthReturnSchema = z
  .object({
    status: z.enum(["ready", "starting", "degraded", "unreachable", "stopped"]),
    reachable: z.boolean(),
    checkedAt: z.number(),
    reason: z.string().optional(),
  })
  .strict();

const channelsStatusReturnSchema = z.object({
  pm2Available: z.boolean(),
  processName: z.string(),
  channels: pm2ProcessReturnSchema,
  processes: z.array(pm2ProcessReturnSchema),
  health: channelsHealthReturnSchema.optional(),
  runner: channelRunnerHealthSnapshotReturnSchema.nullable().optional(),
});

const runtimeTargetReturnSchema = z
  .object({
    bundlePath: z.string(),
    cwd: z.string(),
    sourceProjectRoot: z.string().optional(),
  })
  .strict();

const runnerEnvReturnSchema = z
  .object({
    slackSocketMode: z.boolean(),
    consumeOutbound: z.string(),
  })
  .strict();

const channelsMutationReturnSchema = z
  .object({
    action: z.string(),
    changed: z.boolean(),
    pm2Status: z.number().nullable().optional(),
    target: runtimeTargetReturnSchema.optional(),
    runnerEnv: runnerEnvReturnSchema.optional(),
    status: channelsStatusReturnSchema.optional(),
    reason: z.string().optional(),
  })
  .strict();

const channelsRunStatusReturnSchema = z
  .object({
    running: z.boolean(),
    startedAt: z.number().nullable(),
    pid: z.number(),
    outbound: jsonObjectSchema,
    adapters: z.array(jsonObjectSchema),
  })
  .strict();

const channelConfigReturnSchema = z
  .object({
    name: z.string(),
    provider: z.string(),
    enabled: z.boolean().optional(),
    credentialConnection: z.string().optional(),
    defaults: jsonObjectSchema.optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
    deletedAt: z.number().optional(),
  })
  .strict();

const channelsListReturnSchema = z
  .object({
    total: z.number(),
    pagination: strictCliOffsetPaginationSchema,
    channels: z.array(channelConfigReturnSchema),
    items: z.array(channelConfigReturnSchema),
  })
  .strict();

const channelMutationReturnSchema = z
  .object({
    status: z.string(),
    channel: channelConfigReturnSchema,
    changedCount: z.number(),
  })
  .strict();

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function emitConfigChanged() {
  nats.emit("ravi.config.changed", {}).catch(() => {});
}

/**
 * Manual v2 not-found envelope (exit 1) for the native channel CONFIG domain.
 * `CHANNEL_NOT_FOUND` here refers to a Ravi channel config record in the local
 * router DB — not to a Slack workspace channel (the `slack` domain reuses the
 * same code for that distinct resource). Config names feed `suggestions`.
 */
function failChannelNotFound(op: string, name: string, asJson?: boolean): never {
  const candidates = dbListChannels().map((channel) => channel.name);
  contractFail(op, "CHANNEL_NOT_FOUND", `Channel not found: ${name}`, {
    asJson,
    details: {
      suggestedAction: "Check the channel config name (see suggestions; list with: ravi channels list --json)",
      suggestions: suggestSimilar(name, candidates),
    },
  });
}

function requireCredentialConnectionForChannel(
  op: string,
  provider: string,
  connection: string,
  asJson?: boolean,
): void {
  const record = getCredentialConnection(provider, connection);
  if (!record) {
    // Cross-domain not-found envelope: the referenced Credential Manager
    // connection does not exist. Suggestions carry only provider:connection
    // ids — never secret values or secret refs.
    const candidates = listCredentialConnections({ includeDisabled: true, limit: 100 }).items.map(
      (item) => `${item.provider}:${item.connection}`,
    );
    contractFail(op, "CREDENTIAL_CONNECTION_NOT_FOUND", `Credential connection not found: ${provider}:${connection}`, {
      asJson,
      details: {
        suggestedAction: `Add it with: ravi credentials connections add --provider ${provider} --connection ${connection}`,
        suggestions: suggestSimilar(`${provider}:${connection}`, candidates),
      },
    });
  }
  if (record.status !== "active") {
    fail(`Credential connection is not active: ${provider}:${connection}`);
  }
}

function parseEnabledValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "on", "open", "enabled"].includes(normalized)) return true;
  if (["false", "0", "off", "closed", "disabled"].includes(normalized)) return false;
  fail(`Invalid enabled value: ${value}. Valid: true, false`);
}

function isClearValue(value: string): boolean {
  return ["-", "null", "none", "undefined", ""].includes(value.trim().toLowerCase());
}

const RUNNER_ENV_KEYS = [
  "RAVI_CHANNELS_CONSUME_OUTBOUND",
  "RAVI_SLACK_SUBSCRIPTION_SCOPE",
  "RAVI_SLACK_THREAD_REPLY_MODE",
  "RAVI_SLACK_ROOT_REPLY_MODE",
  "RAVI_SLACK_WORKING_REACTION",
] as const;

function runPm2Quiet(
  args: string[],
  options: { cwd?: string; envOverrides?: Record<string, string> } = {},
): { status: number } {
  const result = spawnSync("pm2", args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    cwd: options.cwd,
    env: buildPm2Env(options.envOverrides),
  });
  return { status: result.status ?? 1 };
}

function cleanEnvValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readExistingPm2Env(processName: string): Record<string, unknown> {
  const result = spawnSync("pm2", ["jlist"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });
  if ((result.status ?? 1) !== 0 || !result.stdout.trim()) return {};
  try {
    const list = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(list)) return {};
    const processInfo = list.find((item) => {
      return item && typeof item === "object" && (item as { name?: unknown }).name === processName;
    }) as { pm2_env?: { env?: Record<string, unknown> } } | undefined;
    return processInfo?.pm2_env?.env ?? {};
  } catch {
    return {};
  }
}

export function buildRunnerPm2Env(): Record<string, string> {
  const existingPm2Env = readExistingPm2Env(CHANNELS_PM2_PROCESS_NAME);
  const envOverrides: Record<string, string> = {};

  for (const key of RUNNER_ENV_KEYS) {
    const value = cleanEnvValue(process.env[key]) ?? cleanEnvValue(existingPm2Env[key]);
    if (value) envOverrides[key] = value;
  }

  return envOverrides;
}

function publicRunnerEnv(envOverrides: Record<string, string>): Record<string, unknown> {
  return {
    slackSocketMode: true,
    consumeOutbound: envOverrides.RAVI_CHANNELS_CONSUME_OUTBOUND ?? "default",
  };
}

function serializePm2Process(process: ReturnType<typeof getPm2Process>, fallbackName: string): Record<string, unknown> {
  if (!process) {
    return {
      name: fallbackName,
      managed: false,
      running: false,
      status: "not_managed_by_pm2",
      pid: null,
      pmId: null,
      cpu: null,
      memoryBytes: null,
      memoryMb: null,
    };
  }

  return {
    name: process.name,
    managed: true,
    running: process.status === "online",
    status: process.status,
    pid: process.pid,
    pmId: process.pm_id,
    cpu: process.cpu,
    memoryBytes: process.memory,
    memoryMb: Number((process.memory / 1024 / 1024).toFixed(1)),
  };
}

type Pm2ProcessSnapshot = ReturnType<typeof getPm2Processes>[number];

function buildChannelsStatusJson(
  options: { pm2Available?: boolean; processes?: Pm2ProcessSnapshot[] } = {},
): Record<string, unknown> {
  const pm2Available = options.pm2Available ?? isPm2Available();
  const processes = options.processes ?? (pm2Available ? getPm2Processes() : []);
  const channels = processes.find((process) => process.name === CHANNELS_PM2_PROCESS_NAME);

  return {
    pm2Available,
    processName: CHANNELS_PM2_PROCESS_NAME,
    channels: serializePm2Process(channels, CHANNELS_PM2_PROCESS_NAME),
    processes: processes.map((process) => serializePm2Process(process, process.name)),
  };
}

export type ChannelsRunnerHealthState = "ready" | "starting" | "degraded" | "unreachable" | "stopped";

export function classifyChannelRunnerHealth(snapshot: ChannelRunnerHealthSnapshot): ChannelsRunnerHealthState {
  if (!snapshot.running) return "degraded";
  if (!snapshot.outbound.infrastructureReady) return "starting";
  if (snapshot.outbound.lastError) return "degraded";
  if (snapshot.outbound.publishOutbox?.lastError && snapshot.outbound.publishOutbox.pendingCount > 0) return "degraded";

  if (snapshot.adapters.some((adapter) => ["failed", "degraded", "disconnected"].includes(adapter.status))) {
    return "degraded";
  }
  if (snapshot.adapters.some((adapter) => ["starting", "reconnecting"].includes(adapter.status))) {
    return "starting";
  }
  if (snapshot.outbound.enabled && !snapshot.outbound.consuming) return "starting";
  return "ready";
}

export async function buildChannelsLiveStatusJson(
  options: {
    pm2Available?: boolean;
    processes?: Pm2ProcessSnapshot[];
    refreshProcesses?: () => Pm2ProcessSnapshot[];
    probe?: (options: { pid: number }) => Promise<ChannelRunnerHealthProbeResult>;
    now?: () => number;
  } = {},
): Promise<Record<string, unknown>> {
  const pm2Available = options.pm2Available ?? isPm2Available();
  const processes = options.processes ?? (pm2Available ? getPm2Processes() : []);
  const refreshProcesses = options.refreshProcesses ?? (options.processes === undefined ? getPm2Processes : undefined);
  const payload = buildChannelsStatusJson({ pm2Available, processes });
  const checkedAt = options.now?.() ?? Date.now();
  const channels = processes.find((process) => process.name === CHANNELS_PM2_PROCESS_NAME);

  if (!pm2Available) {
    return {
      ...payload,
      health: { status: "stopped", reachable: false, checkedAt, reason: "pm2_unavailable" },
      runner: null,
    };
  }
  if (!channels || channels.status !== "online") {
    return {
      ...payload,
      health: { status: "stopped", reachable: false, checkedAt, reason: "not_running" },
      runner: null,
    };
  }
  if (!Number.isSafeInteger(channels.pid) || channels.pid <= 0) {
    return {
      ...payload,
      health: { status: "unreachable", reachable: false, checkedAt, reason: "invalid_pid" },
      runner: null,
    };
  }

  const result = await (options.probe ?? probeChannelRunnerHealth)({ pid: channels.pid });
  if (!result.reachable) {
    const refreshed = refreshProcesses?.();
    const refreshedChannels = refreshed?.find((process) => process.name === CHANNELS_PM2_PROCESS_NAME);
    if (refreshed && (refreshedChannels?.pid !== channels.pid || refreshedChannels?.status !== channels.status)) {
      return buildChannelsLiveStatusJson({
        ...options,
        processes: refreshed,
        refreshProcesses: undefined,
      });
    }
    return {
      ...payload,
      health: { status: "unreachable", reachable: false, checkedAt, reason: result.reason },
      runner: null,
    };
  }

  return {
    ...payload,
    health: {
      status: classifyChannelRunnerHealth(result.snapshot),
      reachable: true,
      checkedAt,
    },
    runner: result.snapshot,
  };
}

function requirePm2(): void {
  if (!isPm2Available()) {
    fail("PM2 not found. Install it: bun add -g pm2");
  }
}

function requireRuntimeTarget(build?: boolean): DaemonRuntimeTarget {
  const target = resolveDaemonRuntimeTarget({ build });
  if (!target) {
    fail("Could not resolve Ravi runtime bundle. Use --build from the source repo or set RAVI_BUNDLE.");
  }
  const validation = validateChannelRunnerRuntimeTarget(target);
  if (!validation.ok) fail(validation.message);
  return target;
}

export type ChannelRunnerRuntimeTargetValidation =
  | { ok: true }
  | {
      ok: false;
      message: string;
      targetBundle: string;
      daemonBundle: string | null;
    };

export function validateChannelRunnerRuntimeTarget(
  target: DaemonRuntimeTarget,
  options: { inspectRuntimeTarget?: () => CliRuntimeTargetSummary } = {},
): ChannelRunnerRuntimeTargetValidation {
  const summary = (options.inspectRuntimeTarget ?? inspectCliRuntimeTarget)();
  if (!summary.daemon.online) return { ok: true };

  const targetBundle = normalizeComparablePath(target.bundlePath) ?? target.bundlePath.toLowerCase();
  const daemonBundle = normalizeComparablePath(summary.daemon.execPath);
  if (!daemonBundle) {
    return {
      ok: false,
      targetBundle,
      daemonBundle,
      message: [
        "Cannot start channel runner because the live daemon bundle is unknown.",
        `Target bundle: ${target.bundlePath}`,
        "Run `ravi daemon status --json` and restart channels only from the daemon-authoritative runtime.",
      ].join("\n"),
    };
  }
  if (targetBundle === daemonBundle) return { ok: true };

  return {
    ok: false,
    targetBundle,
    daemonBundle,
    message: [
      "Refusing to start channel runner from a bundle that diverges from the live daemon.",
      `Target bundle: ${target.bundlePath}`,
      `Daemon bundle: ${summary.daemon.execPath ?? "-"}`,
      "Use the same repo/runtime as the live daemon, or restart the daemon first with the intended bundle.",
    ].join("\n"),
  };
}

function normalizeComparablePath(path: string | null | undefined): string | null {
  const trimmed = path?.trim();
  if (!trimmed) return null;
  try {
    return realpathSync(trimmed).toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
}

@Group({
  name: "channels",
  description: "Manage native Ravi channel runner",
  scope: "admin",
})
export class ChannelsCommands {
  @Command({ name: "list", description: "List configured native channels" })
  @CommandAccess({ kind: "read", resource: "channels", action: "list", risk: "low" })
  @Returns(channelsListReturnSchema)
  list(
    @Option({ flags: "--provider <provider>", description: "Filter by provider, e.g. slack" }) provider?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching channels to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--fields <a,b,c>", description: "Compact mode: keep only these fields of each item" })
    fields?: string,
  ) {
    const providerFilter = provider?.trim();
    const channels = dbListChannels().filter((channel) => !providerFilter || channel.provider === providerFilter);
    const page = paginateCliItems(channels, { limit, offset });
    const pagination = buildCliOffsetPagination({
      fields,
      baseCommand: ["ravi", "channels", "list"],
      limit: page.limit,
      offset: page.offset,
      returned: page.items.length,
      total: page.total,
      options: [providerFilter ? "--provider" : null, providerFilter],
    });
    const items = pickFields(page.items, fields);
    const payload = {
      total: page.total,
      pagination,
      channels: items,
      items,
    };
    if (asJson) printJson(payload);
    else if (page.total === 0) {
      console.log("No channels configured.");
    } else {
      for (const channel of page.items) {
        const credential = channel.credentialConnection ? ` credential=${channel.credentialConnection}` : "";
        const status = channel.enabled === false ? "disabled" : "enabled";
        console.log(`${channel.name} (${channel.provider}, ${status})${credential}`);
      }
      console.log(
        `\nTotal: ${page.total} channels (${page.items.length} returned, limit ${page.limit}, offset ${page.offset})`,
      );
      if (pagination.nextCommand) {
        console.log("Next page:");
        console.log(`  ${pagination.nextCommand}`);
      }
    }
    return payload;
  }

  @Command({ name: "show", description: "Show one configured native channel" })
  @CommandAccess({ kind: "read", resource: "channels", action: "show", risk: "low" })
  @Returns(channelConfigReturnSchema)
  show(
    @Arg("name", { description: "Channel config name" }) name: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const channel = dbGetChannel(name);
    if (!channel) failChannelNotFound("channels show", name, asJson);
    if (asJson) printJson(channel);
    else {
      console.log(`Channel: ${channel.name}`);
      console.log(`  provider: ${channel.provider}`);
      console.log(`  enabled: ${channel.enabled === false ? "false" : "true"}`);
      console.log(`  credentialConnection: ${channel.credentialConnection ?? "(not set)"}`);
    }
    return channel;
  }

  // Manual v2: `create` and `set` are intentionally UNBRAKED — they only write
  // reversible local channel CONFIG rows (create ⇄ set enabled=false, set has
  // an inverse `set` for every key); nothing starts or stops the runner.
  @Command({ name: "create", description: "Create or update a native channel config" })
  @CommandAccess({ kind: "mutate", resource: "channels", action: "create", risk: "medium" })
  @Returns(channelMutationReturnSchema)
  create(
    @Arg("name", { description: "Channel config name" }) name: string,
    @Option({ flags: "--provider <provider>", description: "Channel provider, e.g. slack" }) provider?: string,
    @Option({ flags: "--credential-connection <id>", description: "Credential Manager connection id" })
    credentialConnection?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const resolvedProvider = provider?.trim();
    if (!resolvedProvider) fail("Missing --provider <provider>");
    const connection = credentialConnection?.trim();
    if (connection) requireCredentialConnectionForChannel("channels create", resolvedProvider, connection, asJson);
    const channel = dbUpsertChannel({
      name,
      provider: resolvedProvider,
      credentialConnection: connection || undefined,
    });
    emitConfigChanged();
    const payload = { status: "created", channel, changedCount: 1 };
    if (asJson) printJson(payload);
    else console.log(`Channel configured: ${channel.name} (${channel.provider})`);
    return payload;
  }

  @Command({ name: "set", description: "Set a native channel config property" })
  @CommandAccess({ kind: "mutate", resource: "channels", action: "set", risk: "medium" })
  @Returns(channelMutationReturnSchema)
  set(
    @Arg("name", { description: "Channel config name" }) name: string,
    @Arg("key", { description: "Property key: provider|enabled|credentialConnection|defaults" }) key: string,
    @Arg("value", { description: "Property value, or '-' to clear nullable fields" }) value: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const existing = dbGetChannel(name);
    if (!existing) failChannelNotFound("channels set", name, asJson);
    const clear = isClearValue(value);
    if (key === "provider") {
      if (clear) fail("provider cannot be cleared");
      dbUpdateChannel(name, { provider: value.trim() });
    } else if (key === "enabled") {
      if (clear) fail("enabled cannot be cleared");
      dbUpdateChannel(name, { enabled: parseEnabledValue(value) });
    } else if (key === "credentialConnection") {
      if (clear) {
        dbUpdateChannel(name, { credentialConnection: null });
      } else {
        const connection = value.trim();
        if (!connection) fail("credentialConnection cannot be empty");
        requireCredentialConnectionForChannel("channels set", existing.provider, connection, asJson);
        dbUpdateChannel(name, { credentialConnection: connection });
      }
    } else if (key === "defaults") {
      if (clear) {
        dbUpdateChannel(name, { defaults: null });
      } else {
        try {
          const parsed = JSON.parse(value) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            fail(`defaults must be a JSON object, e.g. '{"subscriptionScope":"chat_and_thread"}'`);
          }
          dbUpdateChannel(name, { defaults: parsed as Record<string, unknown> });
        } catch {
          fail(`defaults must be valid JSON object, e.g. '{"subscriptionScope":"chat_and_thread"}'`);
        }
      }
    } else {
      fail("Invalid key. Valid: provider, enabled, credentialConnection, defaults");
    }
    emitConfigChanged();
    const channel = dbGetChannel(name)!;
    const payload = { status: "updated", channel, changedCount: 1 };
    if (asJson) printJson(payload);
    else console.log(`Channel updated: ${channel.name}`);
    return payload;
  }

  @Command({ name: "start", description: "Start the channel runner via PM2" })
  @CommandAccess({ kind: "mutate", resource: "channels", action: "start", risk: "high" })
  @Returns(channelsMutationReturnSchema)
  start(
    @Option({ flags: "-b, --build", description: "Use dist bundle from source repo" }) build?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    requirePm2();

    if (isPm2ProcessRunning(CHANNELS_PM2_PROCESS_NAME)) {
      const payload = {
        action: "start" as const,
        changed: false,
        reason: "already_running",
        status: buildChannelsStatusJson(),
      };
      if (asJson) printJson(payload);
      else console.log("Channel runner is already running");
      return payload;
    }

    const target = requireRuntimeTarget(build);
    const args = ["start", "bun", "--name", CHANNELS_PM2_PROCESS_NAME, "--", target.bundlePath, "channels", "run"];
    const runnerEnv = buildRunnerPm2Env();
    const { status } = asJson
      ? runPm2Quiet(args, { cwd: target.cwd, envOverrides: runnerEnv })
      : runPm2(args, runnerEnv, { cwd: target.cwd });
    const payload = {
      action: "start" as const,
      changed: status === 0,
      pm2Status: status,
      target,
      runnerEnv: publicRunnerEnv(runnerEnv),
      status: buildChannelsStatusJson(),
    };

    if (asJson) {
      printJson(payload);
      if (status !== 0) fail("Failed to start channel runner");
      return payload;
    }
    if (status === 0) console.log("Channel runner started via PM2");
    else fail("Failed to start channel runner");
    return payload;
  }

  @Command({ name: "stop", description: "Stop the channel runner" })
  @CommandAccess({ kind: "mutate", resource: "channels", action: "stop", risk: "medium" })
  @Returns(channelsMutationReturnSchema)
  stop(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    requirePm2();

    if (!isPm2ProcessRunning(CHANNELS_PM2_PROCESS_NAME)) {
      const payload = {
        action: "stop" as const,
        changed: false,
        reason: "not_running",
        status: buildChannelsStatusJson(),
      };
      if (asJson) printJson(payload);
      else console.log("Channel runner is not running");
      return payload;
    }

    const { status } = asJson
      ? runPm2Quiet(["delete", CHANNELS_PM2_PROCESS_NAME])
      : runPm2(["delete", CHANNELS_PM2_PROCESS_NAME]);
    const payload = {
      action: "stop" as const,
      changed: status === 0,
      pm2Status: status,
      status: buildChannelsStatusJson(),
    };
    if (asJson) {
      printJson(payload);
      if (status !== 0) fail("Failed to stop channel runner");
      return payload;
    }
    if (status === 0) console.log("Channel runner stopped");
    else fail("Failed to stop channel runner");
    return payload;
  }

  @Command({ name: "restart", description: "Restart the channel runner" })
  @CommandAccess({ kind: "mutate", resource: "channels", action: "restart", risk: "high" })
  @Returns(channelsMutationReturnSchema)
  restart(
    @Option({ flags: "-b, --build", description: "Use dist bundle from source repo" }) build?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    requirePm2();
    const runnerEnv = buildRunnerPm2Env();
    const target = requireRuntimeTarget(build);

    if (isPm2ProcessRunning(CHANNELS_PM2_PROCESS_NAME)) {
      const stopped = asJson
        ? runPm2Quiet(["delete", CHANNELS_PM2_PROCESS_NAME])
        : runPm2(["delete", CHANNELS_PM2_PROCESS_NAME]);
      if (stopped.status !== 0) fail("Failed to stop channel runner before restart");
    }

    const args = ["start", "bun", "--name", CHANNELS_PM2_PROCESS_NAME, "--", target.bundlePath, "channels", "run"];
    const { status } = asJson
      ? runPm2Quiet(args, { cwd: target.cwd, envOverrides: runnerEnv })
      : runPm2(args, runnerEnv, { cwd: target.cwd });
    const payload = {
      action: "restart" as const,
      changed: status === 0,
      pm2Status: status,
      target,
      runnerEnv: publicRunnerEnv(runnerEnv),
      status: buildChannelsStatusJson(),
    };
    if (asJson) {
      printJson(payload);
      if (status !== 0) fail("Failed to restart channel runner");
      return payload;
    }
    if (status === 0) console.log("Channel runner restarted");
    else fail("Failed to restart channel runner");
    return payload;
  }

  @Command({ name: "status", description: "Show channel runner status" })
  @CommandAccess({ kind: "read", resource: "channels", action: "status", risk: "low" })
  @Returns(channelsStatusReturnSchema)
  async status(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    const payload = await buildChannelsLiveStatusJson();
    if (asJson) {
      printJson(payload);
      return payload;
    }

    console.log("\nRavi Channels Status");
    console.log("--------------------");
    if (!payload.pm2Available) {
      console.log("  PM2 not installed. Install: bun add -g pm2");
      return payload;
    }
    const channels = payload.channels as Record<string, unknown>;
    console.log(
      `  ${CHANNELS_PM2_PROCESS_NAME}: ${String(channels.status)}${channels.pid ? ` (PID ${channels.pid})` : ""}`,
    );
    const health = payload.health as Record<string, unknown>;
    console.log(`  health: ${String(health.status)}${health.reason ? ` (${String(health.reason)})` : ""}`);
    const runner = payload.runner as ChannelRunnerHealthSnapshot | null;
    for (const adapter of runner?.adapters ?? []) {
      console.log(`  ${adapter.id}: ${adapter.status}${adapter.reason ? ` (${adapter.reason})` : ""}`);
    }
    return payload;
  }

  @Command({ name: "logs", description: "Show channel runner PM2 logs" })
  @CommandAccess({ kind: "read", resource: "channels", action: "logs", risk: "low" })
  @CliOnly()
  logs(@Option({ flags: "--lines <n>", description: "Number of log lines", defaultValue: "100" }) lines?: string) {
    requirePm2();
    return runPm2(["logs", CHANNELS_PM2_PROCESS_NAME, "--lines", lines ?? "100"]);
  }

  @Command({ name: "run", description: "Run channel runner in foreground (used by PM2)" })
  @CommandAccess({ kind: "mutate", resource: "channels", action: "run", risk: "high" })
  @Scope("open")
  @CliOnly()
  async run() {
    await runChannelRunnerFromEnv();
  }

  @Command({ name: "probe", description: "Start channel runner infrastructure and print foreground status" })
  @CommandAccess({ kind: "mutate", resource: "channels", action: "probe", risk: "high" })
  @Returns(channelsRunStatusReturnSchema)
  async probe(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    const runner = new ChannelRunner({ consumeOutbound: false });
    try {
      await runner.start();
      const payload = runner.status();
      if (asJson) printJson(payload);
      else {
        console.log("\nChannel runner probe");
        console.log(`  running: ${payload.running ? "yes" : "no"}`);
        console.log(`  outbound stream: ${payload.outbound.stream}`);
        console.log(`  outbound consumer: ${payload.outbound.consumer}`);
        console.log(`  adapters: ${payload.adapters.length}`);
      }
      return payload;
    } finally {
      await runner.stop();
    }
  }
}
