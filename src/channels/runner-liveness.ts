import { execFile } from "node:child_process";
import { CHANNELS_PM2_PROCESS_NAME, getPm2Process, isPm2Available, type Pm2Process } from "../pm2.js";
import {
  probeChannelRunnerHealth,
  type ChannelRunnerHealthProbeFailureReason,
  type ChannelRunnerHealthProbeResult,
} from "./health.js";

/**
 * PID-scoped health failures that prove the PM2-online `ravi-channels` process
 * is not serving: nobody answers its health subject, it hangs, or a different
 * process answers. Only these justify bouncing it. `nats_unavailable` and
 * `invalid_response` say nothing about the runner itself.
 */
export const STALE_CHANNEL_RUNNER_HEALTH_REASONS = ["timeout", "no_responders", "pid_mismatch"] as const;

export type StaleChannelRunnerHealthReason = (typeof STALE_CHANNEL_RUNNER_HEALTH_REASONS)[number];

export type ChannelRunnerStartDecision =
  | { action: "start" }
  | { action: "already_running"; pid: number }
  | { action: "bounce"; pid: number | null; reason: StaleChannelRunnerHealthReason }
  | { action: "unconfirmed"; pid: number; reason: ChannelRunnerHealthProbeFailureReason };

export function isStaleChannelRunnerHealthReason(reason: string): reason is StaleChannelRunnerHealthReason {
  return (STALE_CHANNEL_RUNNER_HEALTH_REASONS as readonly string[]).includes(reason);
}

export function decideChannelRunnerStartAction(input: {
  pm2Online: boolean;
  pid?: number | null;
  health?: ChannelRunnerHealthProbeResult | null;
}): ChannelRunnerStartDecision {
  if (!input.pm2Online) return { action: "start" };
  const pid = input.pid ?? null;
  // PM2 says online but has no usable PID: there is nothing to probe, and a
  // live runner always has one, so treat it as stale.
  if (pid === null || !Number.isSafeInteger(pid) || pid <= 0) {
    return { action: "bounce", pid: null, reason: "pid_mismatch" };
  }
  const health = input.health;
  if (!health) return { action: "unconfirmed", pid, reason: "nats_unavailable" };
  if (health.reachable) return { action: "already_running", pid };
  if (isStaleChannelRunnerHealthReason(health.reason)) return { action: "bounce", pid, reason: health.reason };
  return { action: "unconfirmed", pid, reason: health.reason };
}

/** Reads the PM2 entry and probes its PID-scoped health subject. */
export async function inspectManagedChannelRunner(
  options: {
    isAvailable?: () => boolean;
    getProcess?: () => Pm2Process | undefined | Promise<Pm2Process | undefined>;
    probe?: (input: { pid: number }) => Promise<ChannelRunnerHealthProbeResult>;
  } = {},
): Promise<ChannelRunnerStartDecision & { pm2Available: boolean }> {
  if (!(options.isAvailable ?? isPm2Available)()) return { action: "start", pm2Available: false };
  const processInfo = await (options.getProcess ?? (() => getPm2Process(CHANNELS_PM2_PROCESS_NAME)))();
  const pm2Online = processInfo?.status === "online";
  const pid = processInfo?.pid ?? null;
  const probeable = pm2Online && pid !== null && Number.isSafeInteger(pid) && pid > 0;
  const health = probeable ? await (options.probe ?? probeChannelRunnerHealth)({ pid }) : null;
  return { ...decideChannelRunnerStartAction({ pm2Online, pid, health }), pm2Available: true };
}

/**
 * Non-blocking `pm2 jlist` lookup for long-lived processes (the daemon), where
 * the synchronous helpers in pm2.ts would stall the event loop. Resolves
 * undefined when PM2 is missing, fails, or has no `ravi-channels` entry.
 */
export function readChannelRunnerPm2ProcessAsync(): Promise<Pm2Process | undefined> {
  return new Promise((resolve) => {
    execFile("pm2", ["jlist"], { encoding: "utf-8", timeout: 15_000 }, (error, stdout) => {
      if (error) return resolve(undefined);
      try {
        const list: unknown = JSON.parse(stdout.trim() || "[]");
        const entry = Array.isArray(list)
          ? (list as Array<Record<string, any>>).find((item) => item?.name === CHANNELS_PM2_PROCESS_NAME)
          : undefined;
        if (!entry) return resolve(undefined);
        resolve({
          name: CHANNELS_PM2_PROCESS_NAME,
          pm_id: entry.pm_id,
          pid: entry.pid,
          status: entry.pm2_env?.status ?? "unknown",
          cpu: entry.monit?.cpu ?? 0,
          memory: entry.monit?.memory ?? 0,
        });
      } catch {
        resolve(undefined);
      }
    });
  });
}

export const CHANNEL_RUNNER_LIVENESS_CHECK_DELAY_MS = 30_000;

/**
 * Daemon-start check, report-only: after a grace period (the runner needs time
 * to reconnect to the restarted NATS and resubscribe its health responder),
 * report a PM2-online runner that does not answer. It never bounces, since a
 * bounce drops Slack briefly; `ravi channels start` does the bounce on demand.
 */
export function scheduleChannelRunnerLivenessReport(options: {
  report: (decision: Extract<ChannelRunnerStartDecision, { action: "bounce" | "unconfirmed" }>) => void;
  isStopping?: () => boolean;
  delayMs?: number;
  inspect?: () => Promise<ChannelRunnerStartDecision>;
  onError?: (error: unknown) => void;
}): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    if (options.isStopping?.()) return;
    (
      options.inspect ??
      (() => inspectManagedChannelRunner({ isAvailable: () => true, getProcess: readChannelRunnerPm2ProcessAsync }))
    )()
      .then((decision) => {
        if (options.isStopping?.()) return;
        if (decision.action === "bounce" || decision.action === "unconfirmed") options.report(decision);
      })
      .catch((error) => options.onError?.(error));
  }, options.delayMs ?? CHANNEL_RUNNER_LIVENESS_CHECK_DELAY_MS);
  timer.unref?.();
  return timer;
}
