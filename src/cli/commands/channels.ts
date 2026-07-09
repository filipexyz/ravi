/**
 * Channels Commands - manage native Ravi channel runner.
 */

import "reflect-metadata";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { ChannelRunner, runChannelRunnerFromEnv } from "../../channels/runner.js";
import {
  CHANNELS_PM2_PROCESS_NAME,
  getPm2Process,
  getPm2Processes,
  isPm2Available,
  isPm2ProcessRunning,
  runPm2,
} from "../../pm2.js";
import { CliOnly, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { fail } from "../context.js";
import { jsonObjectSchema } from "../return-schemas.js";
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

const channelsStatusReturnSchema = z.object({
  pm2Available: z.boolean(),
  processName: z.string(),
  channels: pm2ProcessReturnSchema,
  processes: z.array(pm2ProcessReturnSchema),
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
    slackConnection: z.string().nullable(),
    slackConnections: z.array(z.string()).optional(),
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

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

const RUNNER_ENV_KEYS = [
  "RAVI_CHANNELS_CONSUME_OUTBOUND",
  "RAVI_SLACK_CONNECTIONS",
  "RAVI_SLACK_SUBSCRIPTION_SCOPE",
  "RAVI_SLACK_THREAD_REPLY_MODE",
  "RAVI_SLACK_ROOT_REPLY_MODE",
  "RAVI_SLACK_WORKING_REACTION",
] as const;

const RUNNER_TRANSIENT_ENV_KEYS = new Set([
  "RAVI_ACCOUNT_ID",
  "RAVI_ACTOR_TYPE",
  "RAVI_AGENT_ID",
  "RAVI_CANONICAL_CHAT_ID",
  "RAVI_CHANNEL",
  "RAVI_CHAT_ID",
  "RAVI_CONTACT_ID",
  "RAVI_CONTEXT_ID",
  "RAVI_CONTEXT_KEY",
  "RAVI_INSTANCE_ID",
  "RAVI_MODEL",
  "RAVI_NORMALIZED_SENDER_ID",
  "RAVI_PARENT_CONTEXT_ID",
  "RAVI_PLATFORM_IDENTITY_ID",
  "RAVI_RAW_SENDER_ID",
  "RAVI_SENDER_ID",
  "RAVI_SENDER_NAME",
  "RAVI_SENDER_PHONE",
  "RAVI_SESSION_KEY",
  "RAVI_SESSION_NAME",
  "RAVI_TURN_ID",
  "RAVI_TURN_KEY",
]);

const RUNNER_SECRET_ENV_KEYS = new Set([
  "RAVI_SLACK_APP_TOKEN",
  "RAVI_SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_BOT_TOKEN",
]);

function isTransientRunnerEnvKey(key: string): boolean {
  return RUNNER_TRANSIENT_ENV_KEYS.has(key) || key.startsWith("RAVI_SOURCE_") || key.startsWith("RAVI_TURN_");
}

export function buildRunnerPm2ProcessEnv(input: {
  baseEnv?: Record<string, string | undefined>;
  envOverrides?: Record<string, string>;
}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.baseEnv ?? process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  for (const [key, value] of Object.entries(input.envOverrides ?? {})) {
    env[key] = value;
  }

  for (const key of Object.keys(env)) {
    if (isTransientRunnerEnvKey(key) || RUNNER_SECRET_ENV_KEYS.has(key)) {
      delete env[key];
    }
  }

  return env;
}

function runPm2Detached(
  args: string[],
  options: { cwd?: string; envOverrides?: Record<string, string>; quiet?: boolean } = {},
): { status: number } {
  const result = spawnSync("pm2", args, {
    stdio: options.quiet ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: options.quiet ? "utf-8" : undefined,
    cwd: options.cwd,
    env: buildRunnerPm2ProcessEnv({ envOverrides: options.envOverrides }),
  });
  return { status: result.status ?? 1 };
}

function runPm2Quiet(
  args: string[],
  options: { cwd?: string; envOverrides?: Record<string, string> } = {},
): { status: number } {
  return runPm2Detached(args, { ...options, quiet: true });
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

export function chooseSlackRunnerConnection(input: {
  explicit?: string;
  env?: Record<string, unknown>;
}): string | undefined {
  const explicit = cleanEnvValue(input.explicit);
  if (explicit) return explicit;

  const envConnection =
    cleanEnvValue(input.env?.RAVI_SLACK_CONNECTION) ?? cleanEnvValue(input.env?.RAVI_SLACK_CREDENTIAL_CONNECTION);
  if (envConnection) return envConnection;

  return undefined;
}

function collectCsv(value: string | undefined): string[] {
  if (!value) return [];
  return Array.from(
    new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function buildRunnerPm2Env(
  explicitSlackConnection?: string,
  explicitSlackConnections?: string,
): Record<string, string> {
  const existingPm2Env = readExistingPm2Env(CHANNELS_PM2_PROCESS_NAME);
  const envOverrides: Record<string, string> = {};

  for (const key of RUNNER_ENV_KEYS) {
    const value = cleanEnvValue(process.env[key]) ?? cleanEnvValue(existingPm2Env[key]);
    if (value) envOverrides[key] = value;
  }

  const slackConnections = cleanEnvValue(explicitSlackConnections);
  if (slackConnections) {
    envOverrides.RAVI_SLACK_CONNECTIONS = slackConnections;
    delete envOverrides.RAVI_SLACK_CONNECTION;
    return envOverrides;
  }

  const slackConnection = chooseSlackRunnerConnection({ explicit: explicitSlackConnection, env: process.env });
  if (slackConnection) {
    envOverrides.RAVI_SLACK_CONNECTION = slackConnection;
  }

  return envOverrides;
}

function publicRunnerEnv(envOverrides: Record<string, string>): Record<string, unknown> {
  return {
    slackSocketMode: true,
    slackConnection: envOverrides.RAVI_SLACK_CONNECTION ?? null,
    slackConnections: collectCsv(envOverrides.RAVI_SLACK_CONNECTIONS),
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

function buildChannelsStatusJson(): Record<string, unknown> {
  const pm2Available = isPm2Available();
  const processes = pm2Available ? getPm2Processes() : [];
  const channels = processes.find((process) => process.name === CHANNELS_PM2_PROCESS_NAME);

  return {
    pm2Available,
    processName: CHANNELS_PM2_PROCESS_NAME,
    channels: serializePm2Process(channels, CHANNELS_PM2_PROCESS_NAME),
    processes: processes.map((process) => serializePm2Process(process, process.name)),
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
  return target;
}

@Group({
  name: "channels",
  description: "Manage native Ravi channel runner",
  scope: "admin",
})
export class ChannelsCommands {
  @Command({ name: "start", description: "Start the channel runner via PM2" })
  @CommandAccess({ kind: "mutate", resource: "channels", action: "start", risk: "high" })
  @Returns(channelsMutationReturnSchema)
  start(
    @Option({ flags: "-b, --build", description: "Use dist bundle from source repo" }) build?: boolean,
    @Option({ flags: "--slack-connection <name>", description: "Optional Slack credential connection override" })
    slackConnection?: string,
    @Option({
      flags: "--slack-connections <csv>",
      description: "Comma-separated Slack credential connections to run in one native runner",
    })
    slackConnections?: string,
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
    const runnerEnv = buildRunnerPm2Env(slackConnection, slackConnections);
    const { status } = asJson
      ? runPm2Quiet(args, { cwd: target.cwd, envOverrides: runnerEnv })
      : runPm2Detached(args, { cwd: target.cwd, envOverrides: runnerEnv });
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
    @Option({ flags: "--slack-connection <name>", description: "Optional Slack credential connection override" })
    slackConnection?: string,
    @Option({
      flags: "--slack-connections <csv>",
      description: "Comma-separated Slack credential connections to run in one native runner",
    })
    slackConnections?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    requirePm2();
    const runnerEnv = buildRunnerPm2Env(slackConnection, slackConnections);

    if (isPm2ProcessRunning(CHANNELS_PM2_PROCESS_NAME)) {
      const stopped = asJson
        ? runPm2Quiet(["delete", CHANNELS_PM2_PROCESS_NAME])
        : runPm2(["delete", CHANNELS_PM2_PROCESS_NAME]);
      if (stopped.status !== 0) fail("Failed to stop channel runner before restart");
    }

    const target = requireRuntimeTarget(build);
    const args = ["start", "bun", "--name", CHANNELS_PM2_PROCESS_NAME, "--", target.bundlePath, "channels", "run"];
    const { status } = asJson
      ? runPm2Quiet(args, { cwd: target.cwd, envOverrides: runnerEnv })
      : runPm2Detached(args, { cwd: target.cwd, envOverrides: runnerEnv });
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
  status(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    const payload = buildChannelsStatusJson();
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
  @CliOnly()
  async run() {
    await runChannelRunnerFromEnv();
  }

  @Command({ name: "probe", description: "Start channel runner infrastructure and print foreground status" })
  @CommandAccess({ kind: "read", resource: "channels", action: "probe", risk: "low" })
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
