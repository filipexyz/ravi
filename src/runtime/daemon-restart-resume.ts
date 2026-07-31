import type { RuntimeLaunchPrompt } from "./message-types.js";

export const CRASH_RECOVERY_RESTART_RESUME_MODE_METADATA_KEY = "crashRecoveryRestartResumeMode";

export type CrashRecoveryRestartResumeMode = "continue" | "pending_only" | "skip";

export interface CrashRecoveryRestartResumeDecision {
  mode: CrashRecoveryRestartResumeMode;
  publish: boolean;
  reason: "continue" | "pending_only" | "unsafe_snapshot" | "missing_snapshot" | "ineligible_snapshot";
}

export function resolveCrashRecoveryRestartResumeMode(
  metadata?: Record<string, unknown>,
): CrashRecoveryRestartResumeMode {
  const hasPersistedMode = Boolean(
    metadata && Object.prototype.hasOwnProperty.call(metadata, CRASH_RECOVERY_RESTART_RESUME_MODE_METADATA_KEY),
  );
  const value = metadata?.[CRASH_RECOVERY_RESTART_RESUME_MODE_METADATA_KEY];
  if (value === "continue" || value === "pending_only" || value === "skip") {
    return value;
  }
  if (hasPersistedMode || metadata?.live === true) {
    return "skip";
  }
  return "continue";
}

export function resolveCrashRecoveryRestartResumeDecision(input: {
  metadata?: Record<string, unknown>;
  snapshotPresent: boolean;
  snapshotEligible: boolean;
}): CrashRecoveryRestartResumeDecision {
  if (!input.snapshotPresent) {
    return { mode: "skip", publish: false, reason: "missing_snapshot" };
  }
  if (!input.snapshotEligible) {
    return { mode: "skip", publish: false, reason: "ineligible_snapshot" };
  }
  const mode = resolveCrashRecoveryRestartResumeMode(input.metadata);
  return mode === "skip" ? { mode, publish: false, reason: "unsafe_snapshot" } : { mode, publish: true, reason: mode };
}

export function buildDaemonRestartResumePrompt(input: {
  restartEpoch: string;
  reason: string;
  sessionKey: string;
  mode: CrashRecoveryRestartResumeMode;
}): (RuntimeLaunchPrompt & Record<string, unknown>) | null {
  if (input.mode === "skip") {
    return null;
  }

  const pendingOnly = input.mode === "pending_only";
  return {
    prompt: pendingOnly
      ? `[System] Daemon reiniciou (${input.reason}). Processe somente as mensagens pendentes duráveis anexadas; não continue o turn interrompido.`
      : `[System] Daemon reiniciou (${input.reason}). Continue de onde parou.`,
    deliveryBarrier: "after_response",
    deliveryBarrierSource: "default",
    _daemonRestartResume: {
      restartEpoch: input.restartEpoch,
      sessionKey: input.sessionKey,
      ...(pendingOnly ? { pendingOnly: true } : {}),
    },
  };
}
