import type { DaemonRestartDeliveryKind, DaemonRestartSessionSnapshotRecord } from "../router/router-db.js";
import { logger } from "../utils/logger.js";
import type { MessageTarget, RuntimeLaunchPrompt } from "./message-types.js";
import type { RuntimeProviderId } from "./types.js";

const log = logger.child("daemon");

export const CRASH_RECOVERY_RESTART_RESUME_MODE_METADATA_KEY = "crashRecoveryRestartResumeMode";

export type CrashRecoveryRestartResumeMode = "continue" | "pending_only" | "skip";

export type DaemonRestartResumeFenceReason = "unsafe_snapshot" | "missing_snapshot" | "ineligible_snapshot";

export type CrashRecoveryRestartResumeDecision =
  | { mode: "continue"; publish: true; reason: "continue" }
  | { mode: "pending_only"; publish: true; reason: "pending_only" }
  | { mode: "skip"; publish: false; reason: DaemonRestartResumeFenceReason };

type DaemonRestartPrompt = RuntimeLaunchPrompt & Record<string, unknown>;

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
  pendingMessageCount?: number;
}): CrashRecoveryRestartResumeDecision {
  if (!input.snapshotPresent) {
    return { mode: "skip", publish: false, reason: "missing_snapshot" };
  }
  if (!input.snapshotEligible) {
    return { mode: "skip", publish: false, reason: "ineligible_snapshot" };
  }
  const mode = resolveCrashRecoveryRestartResumeMode(input.metadata);
  if (mode === "skip" && (input.pendingMessageCount ?? 0) > 0) {
    return { mode: "pending_only", publish: true, reason: "pending_only" };
  }
  if (mode === "skip") {
    return { mode, publish: false, reason: "unsafe_snapshot" };
  }
  return mode === "continue"
    ? { mode, publish: true, reason: "continue" }
    : { mode, publish: true, reason: "pending_only" };
}

interface DaemonRestartResumePromptInput {
  restartEpoch: string;
  reason: string;
  sessionKey: string;
  runtimeProvider?: RuntimeProviderId;
}

export function buildDaemonRestartResumePrompt(
  input: DaemonRestartResumePromptInput & { mode: "continue" | "pending_only" },
): DaemonRestartPrompt;
export function buildDaemonRestartResumePrompt(
  input: DaemonRestartResumePromptInput & { mode: CrashRecoveryRestartResumeMode },
): DaemonRestartPrompt | null;
export function buildDaemonRestartResumePrompt(
  input: DaemonRestartResumePromptInput & { mode: CrashRecoveryRestartResumeMode },
): DaemonRestartPrompt | null {
  if (input.mode === "skip") {
    return null;
  }

  const pendingOnly = input.mode === "pending_only";
  const runtimeProvider = input.runtimeProvider?.trim() || undefined;
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
      ...(runtimeProvider ? { runtimeProvider: runtimeProvider as RuntimeProviderId } : {}),
    },
  };
}

/**
 * Restart notice for a session whose resume was fenced. It reports the restart
 * and tells the agent not to continue on its own; the dispatcher never hydrates
 * the fenced snapshot's pending work for a `noticeOnly` envelope.
 */
export function buildDaemonRestartNoticePrompt(input: {
  restartEpoch: string;
  reason: string;
  sessionKey: string;
  fenceReason: DaemonRestartResumeFenceReason;
  snapshotMetadata?: Record<string, unknown>;
  runtimeProvider?: RuntimeProviderId;
}): DaemonRestartPrompt {
  const runtimeProvider = input.runtimeProvider?.trim() || undefined;
  return {
    prompt: [
      `[System] Daemon reiniciou (${input.reason}).`,
      describeRestartResumeFence(input.fenceReason, input.snapshotMetadata),
      "Não continue nem repita trabalho interrompido por conta própria: avise o operador sobre o restart e o que ficou pendente, e aguarde instrução.",
    ].join(" "),
    deliveryBarrier: "after_response",
    deliveryBarrierSource: "default",
    _daemonRestartResume: {
      restartEpoch: input.restartEpoch,
      sessionKey: input.sessionKey,
      noticeOnly: true,
      ...(runtimeProvider ? { runtimeProvider: runtimeProvider as RuntimeProviderId } : {}),
    },
  };
}

function describeRestartResumeFence(
  fenceReason: DaemonRestartResumeFenceReason,
  metadata?: Record<string, unknown>,
): string {
  switch (fenceReason) {
    case "unsafe_snapshot": {
      const evidence = describeUnsafeSnapshotEvidence(metadata);
      return `O turn interrompido não foi retomado automaticamente porque não é seguro repeti-lo${
        evidence.length > 0 ? ` (${evidence.join("; ")})` : ""
      }.`;
    }
    case "missing_snapshot":
      return "Não há snapshot de restart desta sessão, então nenhum trabalho interrompido foi retomado automaticamente.";
    case "ineligible_snapshot":
      return "O snapshot de restart desta sessão está fora da janela de retomada, então nenhum trabalho interrompido foi retomado automaticamente.";
  }
}

function describeUnsafeSnapshotEvidence(metadata?: Record<string, unknown>): string[] {
  const safety = asRecord(metadata?.crashRecoveryReplaySafety);
  const toolName = cleanString(metadata?.currentToolName);
  const terminalStatus = cleanString(metadata?.crashRecoveryTerminalStatus);
  const evidence: string[] = [];
  if (safety?.startedTool === true) {
    evidence.push(toolName ? `ferramenta ${toolName} já iniciada` : "ferramenta já iniciada");
  }
  if (safety?.materializedOutput === true) {
    evidence.push("resposta já emitida");
  }
  if (safety?.inputMutated === true) {
    evidence.push("input alterado durante o turn");
  }
  if (terminalStatus) {
    evidence.push(`turn já finalizado no provider (${terminalStatus})`);
  }
  return evidence;
}

export interface DaemonRestartSessionEventInput {
  restartEpoch: string;
  reason: string;
  sessionName: string;
  sessionKey: string;
  kind: "caller" | "active";
  snapshot?: DaemonRestartSessionSnapshotRecord;
  snapshotEligible?: boolean;
}

export interface DaemonRestartSessionEventDeps {
  hasDelivery(restartEpoch: string, sessionKey: string): boolean;
  markDelivered(input: {
    restartEpoch: string;
    sessionKey: string;
    sessionName: string;
    deliveryKind: DaemonRestartDeliveryKind;
    decisionReason: CrashRecoveryRestartResumeDecision["reason"];
  }): unknown;
  publish(sessionName: string, payload: DaemonRestartPrompt): Promise<void>;
  isTerminalTaskSession(sessionName: string, snapshot?: DaemonRestartSessionSnapshotRecord): boolean;
  resolveSource(snapshot?: DaemonRestartSessionSnapshotRecord): MessageTarget | undefined;
}

export type DaemonRestartSessionEventOutcome =
  | { status: "already_delivered" }
  | { status: "skipped_terminal_task" }
  | {
      status: "delivered" | "failed";
      deliveryKind: DaemonRestartDeliveryKind;
      decision: CrashRecoveryRestartResumeDecision;
    };

/**
 * Deliver the post-restart event for one session. A fenced resume still
 * produces a notice, and the delivery ledger records only what was actually
 * published, tagged with whether it was a resume or a notice.
 */
export async function deliverDaemonRestartSessionEvent(
  input: DaemonRestartSessionEventInput,
  deps: DaemonRestartSessionEventDeps,
): Promise<DaemonRestartSessionEventOutcome> {
  const { restartEpoch, sessionName, sessionKey, kind, snapshot } = input;
  const logContext = { restartEpoch, restartReason: input.reason, sessionName, sessionKey, kind };

  if (deps.hasDelivery(restartEpoch, sessionKey)) {
    log.info("Restart resume event already delivered", logContext);
    return { status: "already_delivered" };
  }

  if (deps.isTerminalTaskSession(sessionName, snapshot)) {
    log.info("Skipping restart resume event for terminal task session", {
      ...logContext,
      taskBarrierTaskId: cleanString(snapshot?.metadata?.currentTaskBarrierTaskId) ?? null,
    });
    return { status: "skipped_terminal_task" };
  }

  const decision = resolveCrashRecoveryRestartResumeDecision({
    metadata: snapshot?.metadata,
    snapshotPresent: Boolean(snapshot),
    snapshotEligible: input.snapshotEligible ?? true,
    pendingMessageCount: snapshot?.pendingMessageCount,
  });
  const runtimeProvider = snapshot?.runtimeProvider as RuntimeProviderId | undefined;
  let deliveryKind: DaemonRestartDeliveryKind;
  let payload: DaemonRestartPrompt;
  if (decision.publish) {
    deliveryKind = "resume";
    payload = buildDaemonRestartResumePrompt({
      restartEpoch,
      reason: input.reason,
      sessionKey,
      mode: decision.mode,
      runtimeProvider,
    });
  } else {
    deliveryKind = "notice";
    log.warn("Restart resume fenced by crash recovery; delivering restart notice instead", {
      ...logContext,
      fenceReason: decision.reason,
    });
    payload = buildDaemonRestartNoticePrompt({
      restartEpoch,
      reason: input.reason,
      sessionKey,
      fenceReason: decision.reason,
      snapshotMetadata: snapshot?.metadata,
      runtimeProvider,
    });
  }

  const source = deps.resolveSource(snapshot);
  if (source) {
    payload.source = source;
  }

  const eventContext = { ...logContext, deliveryKind, decisionReason: decision.reason };
  try {
    log.info(deliveryKind === "resume" ? "Publishing restart resume event" : "Publishing restart notice", {
      ...eventContext,
      sourceActorType: source?.actorType ?? null,
      sourceContactId: source?.contactId ?? null,
    });
    await deps.publish(sessionName, payload);
  } catch (error) {
    log.error("Failed to publish restart event; leaving it unrecorded", { ...eventContext, error });
    return { status: "failed", deliveryKind, decision };
  }

  try {
    deps.markDelivered({ restartEpoch, sessionKey, sessionName, deliveryKind, decisionReason: decision.reason });
  } catch (error) {
    log.error("Restart event published but its delivery record failed", { ...eventContext, error });
  }
  log.info(deliveryKind === "resume" ? "Restart resume event published" : "Restart notice published", eventContext);
  return { status: "delivered", deliveryKind, decision };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
