import { spawnSync } from "node:child_process";
import { nats } from "../nats.js";
import { CHANNELS_PM2_PROCESS_NAME, buildPm2Env, getPm2Process, isPm2Available, type Pm2Process } from "../pm2.js";
import { logger } from "../utils/logger.js";
import { buildRunnerPm2Env } from "./pm2-env.js";
import {
  probeChannelRunnerHealth,
  type ChannelRunnerHealthProbeFailureReason,
  type ChannelRunnerHealthProbeResult,
} from "./health.js";

const log = logger.child("channels:runner-liveness");

export const STALE_CHANNEL_RUNNER_HEALTH_REASONS = ["timeout", "no_responders", "pid_mismatch"] as const;

export type StaleChannelRunnerHealthReason = (typeof STALE_CHANNEL_RUNNER_HEALTH_REASONS)[number];

export type ChannelRunnerStartDecision =
  | { action: "start" }
  | { action: "already_running" }
  | { action: "bounce"; pid: number; reason: StaleChannelRunnerHealthReason }
  | { action: "unconfirmed"; reason: "nats_unavailable" };

export type ChannelRunnerReconcileResult =
  | { action: "none"; reason?: string }
  | { action: "healthy"; pid: number }
  | { action: "bounced"; previousPid: number; reason: string }
  | { action: "unconfirmed"; reason: "nats_unavailable" }
  | { action: "bounce_failed"; previousPid?: number; reason: string };

export function isStaleChannelRunnerHealthReason(
  reason: ChannelRunnerHealthProbeFailureReason | string,
): reason is StaleChannelRunnerHealthReason {
  return (STALE_CHANNEL_RUNNER_HEALTH_REASONS as readonly string[]).includes(reason);
}

export function decideChannelRunnerStartAction(
  options: { pm2Online?: boolean; pid?: number | null; health?: ChannelRunnerHealthProbeResult | null } = {},
): ChannelRunnerStartDecision {
  if (!options.pm2Online) return { action: "start" };
  const health = options.health;
  if (!health) return { action: "unconfirmed", reason: "nats_unavailable" };
  if (health.reachable) return { action: "already_running" };
  if (health.reason === "nats_unavailable") return { action: "unconfirmed", reason: "nats_unavailable" };
  if (isStaleChannelRunnerHealthReason(health.reason)) {
    return { action: "bounce", pid: options.pid ?? 0, reason: health.reason };
  }
  return { action: "unconfirmed", reason: "nats_unavailable" };
}

export function bounceManagedChannelRunnerProcess(options: {
  target: { bundlePath: string; cwd: string };
  reason: string;
  previousPid?: number | null;
  persist?: boolean;
  runPm2?: (args: string[], opts?: { cwd?: string; envOverrides?: Record<string, string> }) => { status: number };
  persistPm2?: () => number;
  emit?: (topic: string, payload: Record<string, unknown>) => Promise<void>;
  runnerEnv?: Record<string, string>;
}): { ok: boolean; pm2Status: number; previousPid?: number; reason: string } {
  const runPm2 = options.runPm2 ?? defaultRunPm2;
  const persistPm2 = options.persistPm2 ?? defaultPersistPm2;
  const emit = options.emit ?? ((topic, payload) => nats.emit(topic, payload));
  const runnerEnv = options.runnerEnv ?? buildRunnerPm2Env();
  const previousPid = options.previousPid ?? undefined;

  const deleted = runPm2(["delete", CHANNELS_PM2_PROCESS_NAME]);
  if (deleted.status !== 0) {
    const result = {
      ok: false,
      pm2Status: deleted.status,
      previousPid,
      reason: options.reason,
    };
    void emit("ravi.channels.runner.reconcile", {
      action: "bounce_failed",
      phase: "delete",
      ...result,
    }).catch((error) => {
      log.warn("Failed to emit channel runner reconcile event", { error });
    });
    return result;
  }

  const startArgs = [
    "start",
    "bun",
    "--name",
    CHANNELS_PM2_PROCESS_NAME,
    "--",
    options.target.bundlePath,
    "channels",
    "run",
  ];
  const started = runPm2(startArgs, { cwd: options.target.cwd, envOverrides: runnerEnv });
  if (started.status !== 0) {
    const result = {
      ok: false,
      pm2Status: started.status,
      previousPid,
      reason: options.reason,
    };
    void emit("ravi.channels.runner.reconcile", {
      action: "bounce_failed",
      phase: "start",
      ...result,
    }).catch((error) => {
      log.warn("Failed to emit channel runner reconcile event", { error });
    });
    return result;
  }

  if (options.persist !== false) {
    const saveStatus = persistPm2();
    if (saveStatus !== 0) {
      const result = {
        ok: false,
        pm2Status: started.status,
        previousPid,
        reason: options.reason,
      };
      void emit("ravi.channels.runner.reconcile", {
        action: "bounce_failed",
        phase: "save",
        ...result,
      }).catch((error) => {
        log.warn("Failed to emit channel runner reconcile event", { error });
      });
      return result;
    }
  }

  const result = {
    ok: true,
    pm2Status: started.status,
    previousPid,
    reason: options.reason,
  };
  void emit("ravi.channels.runner.reconcile", {
    action: "bounced",
    ...result,
  }).catch((error) => {
    log.warn("Failed to emit channel runner reconcile event", { error });
  });
  return result;
}

export async function reconcileManagedChannelRunner(
  options: {
    getProcess?: () => Pm2Process | undefined;
    isAvailable?: () => boolean;
    probe?: (input: { pid: number }) => Promise<ChannelRunnerHealthProbeResult>;
    bounce?: typeof bounceManagedChannelRunnerProcess;
    resolveTarget?: () => { bundlePath: string; cwd: string } | null;
    emit?: (topic: string, payload: Record<string, unknown>) => Promise<void>;
    persist?: boolean;
  } = {},
): Promise<ChannelRunnerReconcileResult> {
  const isAvailable = options.isAvailable ?? isPm2Available;
  if (!isAvailable()) {
    return { action: "none", reason: "pm2_unavailable" };
  }

  const processInfo = (options.getProcess ?? (() => getPm2Process(CHANNELS_PM2_PROCESS_NAME)))();
  if (!processInfo || processInfo.status !== "online") {
    return { action: "none", reason: "not_running" };
  }

  const pid = processInfo.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { action: "none", reason: "invalid_pid" };
  }

  const health = await (options.probe ?? probeChannelRunnerHealth)({ pid });
  const decision = decideChannelRunnerStartAction({
    pm2Online: true,
    pid,
    health,
  });

  if (decision.action === "already_running") {
    return { action: "healthy", pid };
  }
  if (decision.action === "unconfirmed") {
    void (options.emit ?? ((topic, payload) => nats.emit(topic, payload)))("ravi.channels.runner.reconcile", {
      action: "unconfirmed",
      reason: decision.reason,
      pid,
    }).catch((error) => {
      log.warn("Failed to emit channel runner reconcile event", { error });
    });
    return { action: "unconfirmed", reason: decision.reason };
  }
  if (decision.action !== "bounce") {
    return { action: "none" };
  }

  const target = options.resolveTarget?.() ?? resolveManagedChannelRunnerTarget(processInfo);
  if (!target) {
    return { action: "bounce_failed", previousPid: pid, reason: "missing_runtime_target" };
  }

  const bounced = (options.bounce ?? bounceManagedChannelRunnerProcess)({
    target,
    reason: `stale_${decision.reason}`,
    previousPid: decision.pid,
    persist: options.persist ?? false,
    emit: options.emit,
  });
  if (!bounced.ok) {
    return {
      action: "bounce_failed",
      previousPid: pid,
      reason: bounced.reason,
    };
  }
  return { action: "bounced", previousPid: pid, reason: bounced.reason };
}

function resolveManagedChannelRunnerTarget(processInfo: Pm2Process): { bundlePath: string; cwd: string } | null {
  const bundlePath = processInfo.args?.[0];
  const cwd = processInfo.cwd;
  if (!bundlePath || !cwd) return null;
  return { bundlePath, cwd };
}

function defaultRunPm2(
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

function defaultPersistPm2(): number {
  return defaultRunPm2(["save", "--force"]).status;
}
