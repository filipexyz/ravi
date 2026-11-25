import type { DaemonRestartDeliveryKind, DaemonRestartSessionSnapshotRecord } from "../router/router-db.js";
import { logger } from "../utils/logger.js";
import type { RuntimeTurnAuthorityEnvelope } from "./delivery-queue.js";
import type { MessageTarget, RuntimeLaunchPrompt } from "./message-types.js";
import { resolveRuntimeTurnOrigin } from "./turn-origin.js";
import type { RestartAttemptVerdict } from "./restart-turn-recovery.js";
import type { RuntimeProviderId } from "./types.js";

const log = logger.child("daemon");

export const CRASH_RECOVERY_RESTART_RESUME_MODE_METADATA_KEY = "crashRecoveryRestartResumeMode";

/**
 * Where the attempt (at turn start) and the restart snapshot (at shutdown)
 * record the authority envelope of the turn: who it acts for beyond its chat
 * `source` (a relay's `_turnOrigin` narrowing, the message `context`, the
 * approval source). A restart input carries it back, so it never holds more
 * than the turn it resumes.
 */
export const RESTART_TURN_AUTHORITY_METADATA_KEY = "restartTurnAuthority";

type RestartTurnAuthorityFields = Pick<RuntimeLaunchPrompt, "context" | "_turnOrigin" | "_approvalSource">;

export interface RecordedRestartTurnAuthority extends RestartTurnAuthorityFields {
  v: 1;
  /** The turn ran under automation authority (cron, trigger, heartbeat, follow-up): never resumed. */
  automation?: true;
}

export type RestoredRestartTurnAuthority =
  | { ok: true; authority: RestartTurnAuthorityFields }
  | { ok: false; reason: "authority_missing" | "authority_unreadable" | "authority_automation" };

/** JSON-safe record of a turn's authority envelope (no secrets: ids and actor metadata only). */
export function captureRestartTurnAuthority(
  envelope: RuntimeTurnAuthorityEnvelope | null | undefined,
): RecordedRestartTurnAuthority {
  const automation = Boolean(
    envelope?._cron ||
      envelope?._cronAuthority ||
      envelope?._trigger ||
      envelope?._triggerAuthority ||
      envelope?._heartbeat ||
      envelope?._sessionFollowup ||
      envelope?._mcpCall,
  );
  const recorded = {
    v: 1 as const,
    ...(envelope?.context ? { context: envelope.context } : {}),
    ...(envelope?._turnOrigin ? { _turnOrigin: envelope._turnOrigin } : {}),
    ...(envelope?._approvalSource ? { _approvalSource: envelope._approvalSource } : {}),
    ...(automation ? { automation: true as const } : {}),
  };
  return JSON.parse(JSON.stringify(recorded)) as RecordedRestartTurnAuthority;
}

/** Read a recorded authority envelope back; anything absent or malformed fails closed. */
export function restoreRestartTurnAuthority(value: unknown): RestoredRestartTurnAuthority {
  if (value === undefined || value === null) return { ok: false, reason: "authority_missing" };
  const record = asRecord(value);
  if (!record || record.v !== 1) return { ok: false, reason: "authority_unreadable" };
  if (record.automation === true) return { ok: false, reason: "authority_automation" };
  const context = record.context;
  const turnOrigin = record._turnOrigin;
  const approvalSource = record._approvalSource;
  if (context !== undefined && !asRecord(context)) return { ok: false, reason: "authority_unreadable" };
  if (approvalSource !== undefined && !asRecord(approvalSource)) return { ok: false, reason: "authority_unreadable" };
  // The same validation the runtime applies: an origin it would ignore would
  // silently drop the relay narrowing.
  if (turnOrigin !== undefined && resolveRuntimeTurnOrigin(turnOrigin) === null) {
    return { ok: false, reason: "authority_unreadable" };
  }
  return {
    ok: true,
    authority: {
      ...(context !== undefined ? { context: context as RuntimeLaunchPrompt["context"] } : {}),
      ...(turnOrigin !== undefined ? { _turnOrigin: turnOrigin as RuntimeLaunchPrompt["_turnOrigin"] } : {}),
      ...(approvalSource !== undefined
        ? { _approvalSource: approvalSource as RuntimeLaunchPrompt["_approvalSource"] }
        : {}),
    },
  };
}

/**
 * Put the interrupted turn's authority and its recorded chat source on a
 * restart input. The envelope goes first and the source last, like a host-made
 * continuation of the same turn (`host-event-loop`), so the input acts for the
 * same actor and narrowing as the turn it resumes and never more.
 */
export function withRestartTurnAuthority(
  payload: DaemonRestartPrompt,
  authority: RestartTurnAuthorityFields | undefined,
  source: MessageTarget | undefined,
): DaemonRestartPrompt {
  const restored: DaemonRestartPrompt = { ...(authority ?? {}), ...payload };
  if (source) restored.source = source;
  return restored;
}

/** Copy only the reply/actor fields of a recorded chat source. */
export function normalizeRestartResumeSource(source: Record<string, unknown>): MessageTarget | undefined {
  const channel = cleanString(source.channel);
  const accountId = cleanString(source.accountId);
  const chatId = cleanString(source.chatId);
  if (!channel || !accountId || !chatId) {
    return undefined;
  }

  const target: MessageTarget = { channel, accountId, chatId };
  for (const key of [
    "instanceId",
    "threadId",
    "sourceMessageId",
    "canonicalChatId",
    "actorType",
    "contactId",
    "actorAgentId",
    "automationId",
    "platformIdentityId",
    "rawSenderId",
    "normalizedSenderId",
  ] as const) {
    const normalized = cleanString(source[key]);
    if (normalized) {
      (target as unknown as Record<string, unknown>)[key] = normalized;
    }
  }
  if (typeof source.identityConfidence === "number") {
    target.identityConfidence = source.identityConfidence;
  }
  const identityProvenance = asRecord(source.identityProvenance);
  if (identityProvenance) {
    target.identityProvenance = identityProvenance;
  }
  return target;
}

export type CrashRecoveryRestartResumeMode = "continue" | "pending_only" | "skip";

/**
 * `verify_continue` resumes a turn that was interrupted after it started
 * acting. It never replays the original input: the session is told the daemon
 * restarted mid-turn and must check the real state before repeating anything.
 */
export type DaemonRestartResumeMode = CrashRecoveryRestartResumeMode | "verify_continue";

export type DaemonRestartResumeFenceReason =
  | "unsafe_snapshot"
  | "missing_snapshot"
  | "ineligible_snapshot"
  | "resume_loop"
  | "authority_missing"
  | "authority_unreadable"
  | "authority_automation";

export type CrashRecoveryRestartResumeDecision =
  | { mode: "continue"; publish: true; reason: "continue" }
  | { mode: "pending_only"; publish: true; reason: "pending_only" }
  | { mode: "verify_continue"; publish: true; reason: "verify_continue" }
  | { mode: "skip"; publish: false; reason: DaemonRestartResumeFenceReason };

export type DaemonRestartPrompt = RuntimeLaunchPrompt & Record<string, unknown>;

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
  /** For `verify_continue`: what the interrupted turn had already done. */
  evidence?: string[];
  /** For `verify_continue`: the still-active task the interrupted turn ran under. */
  taskBarrierTaskId?: string;
}

export function buildDaemonRestartResumePrompt(
  input: DaemonRestartResumePromptInput & { mode: "continue" | "pending_only" | "verify_continue" },
): DaemonRestartPrompt;
export function buildDaemonRestartResumePrompt(
  input: DaemonRestartResumePromptInput & { mode: DaemonRestartResumeMode },
): DaemonRestartPrompt | null;
export function buildDaemonRestartResumePrompt(
  input: DaemonRestartResumePromptInput & { mode: DaemonRestartResumeMode },
): DaemonRestartPrompt | null {
  if (input.mode === "skip") {
    return null;
  }

  const pendingOnly = input.mode === "pending_only";
  const runtimeProvider = input.runtimeProvider?.trim() || undefined;
  const taskBarrierTaskId = input.mode === "verify_continue" ? input.taskBarrierTaskId?.trim() || undefined : undefined;
  return {
    ...(taskBarrierTaskId ? { taskBarrierTaskId } : {}),
    prompt: pendingOnly
      ? `[System] Daemon reiniciou (${input.reason}). Processe somente as mensagens pendentes duráveis anexadas; não continue o turn interrompido.`
      : input.mode === "verify_continue"
        ? buildVerifyContinueText(input.reason, input.evidence ?? [])
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

function buildVerifyContinueText(reason: string, evidence: string[]): string {
  return [
    `[System] Daemon reiniciou (${reason}) no meio do teu turno, que foi interrompido${
      evidence.length > 0 ? ` (${evidence.join("; ")})` : ""
    }.`,
    "Antes de repetir qualquer ação, confira o estado real (arquivos, git, PRs, mensagens enviadas, comandos e jobs) e não repita efeito que já aconteceu.",
    "Depois continue o trabalho de onde parou.",
  ].join(" ");
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
  /** Other sessions this restart already resumed on their own. */
  resumedSessionNames?: string[];
}): DaemonRestartPrompt {
  const runtimeProvider = input.runtimeProvider?.trim() || undefined;
  const resumedSessionNames = input.resumedSessionNames ?? [];
  return {
    prompt: [
      `[System] Daemon reiniciou (${input.reason}).`,
      describeRestartResumeFence(input.fenceReason, input.snapshotMetadata),
      "Não continue nem repita trabalho interrompido por conta própria: avise o operador sobre o restart e o que ficou pendente, e aguarde instrução.",
      ...(resumedSessionNames.length > 0
        ? [
            `O daemon tenta retomar sozinho o turno interrompido destas sessões (agora ou em até ~2 min, quando o lease do boot anterior expirar), com nota para conferir o estado antes de repetir: ${resumedSessionNames.join(", ")}. Só volta a rodar o turno que tem a autoridade gravada; turno sem ela (por exemplo, gravado antes desta versão) não é retomado e recebe só um aviso. Antes de mandar retomar alguma, confira se ela já voltou.`,
          ]
        : []),
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
    case "resume_loop":
      return "O turn interrompido já era uma retomada automática de um restart anterior, então não foi retomado de novo, para não entrar em laço.";
    case "authority_missing":
    case "authority_unreadable":
    case "authority_automation":
      return "Não foi possível reconstituir a autoridade do turn interrompido, então ele não foi retomado automaticamente.";
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
  /** Sessions this restart already resumed from the crash-recovery ledger. */
  resumedSessionNames?: string[];
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
  /**
   * Judge the durable attempt a snapshot recorded as interrupted mid-action.
   * Without it, an unsafe snapshot keeps the notice-only path. The delivery
   * ledger keeps this to one event per restart epoch and session.
   */
  judgeInterruptedAttempt?(input: { attemptId: string }): RestartAttemptVerdict;
}

export const DAEMON_RESTART_INTERRUPTED_ATTEMPT_METADATA_KEY = "crashRecoveryAttemptId";

/**
 * The attempt a restart snapshot records as interrupted mid-action, or null.
 * Only an active turn that is not replayable, that the provider had not
 * finished (a terminal turn is consumed and never resurrected) and that is not
 * a scheduled capacity retry (pending-only work) qualifies.
 */
export function resolveRestartSnapshotInterruptedAttemptId(input: {
  turnActive: boolean;
  replayable: boolean;
  terminalTurnConsumed: boolean;
  hasScheduledCapacityRetry: boolean;
  /** A newer message already replaced this turn: its work continues there, not here. */
  superseded?: boolean;
  attemptId: string | undefined;
}): string | null {
  if (
    !input.turnActive ||
    input.replayable ||
    input.terminalTurnConsumed ||
    input.hasScheduledCapacityRetry ||
    input.superseded
  ) {
    return null;
  }
  return input.attemptId ?? null;
}

/**
 * The durable attempt a live snapshot recorded as interrupted after it started
 * acting. The dispatcher only records it for an active, non-replayable turn
 * that the provider had not finished and that is not a scheduled capacity
 * retry; replayable turns keep `continue`.
 */
function snapshotInterruptedAttemptId(snapshot?: DaemonRestartSessionSnapshotRecord): string | undefined {
  const metadata = snapshot?.metadata;
  if (!metadata || metadata.live !== true) return undefined;
  return cleanString(metadata[DAEMON_RESTART_INTERRUPTED_ATTEMPT_METADATA_KEY]);
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

  let decision = resolveCrashRecoveryRestartResumeDecision({
    metadata: snapshot?.metadata,
    snapshotPresent: Boolean(snapshot),
    snapshotEligible: input.snapshotEligible ?? true,
    pendingMessageCount: snapshot?.pendingMessageCount,
  });
  let evidence: string[] = [];
  const snapshotAuthority = restoreRestartTurnAuthority(snapshot?.metadata?.[RESTART_TURN_AUTHORITY_METADATA_KEY]);
  let authority: RestartTurnAuthorityFields | undefined;
  const interruptedAttemptId =
    decision.reason === "unsafe_snapshot" || decision.reason === "pending_only"
      ? snapshotInterruptedAttemptId(snapshot)
      : undefined;
  if (interruptedAttemptId && deps.judgeInterruptedAttempt) {
    const verdict = deps.judgeInterruptedAttempt({ attemptId: interruptedAttemptId });
    log.info("Restart snapshot interrupted attempt verdict", {
      ...logContext,
      attemptId: interruptedAttemptId,
      verdict: verdict.kind === "skip" ? `skip:${verdict.reason}` : verdict.kind,
    });
    if (verdict.kind === "resume") {
      decision = { mode: "verify_continue", publish: true, reason: "verify_continue" };
      evidence = describeUnsafeSnapshotEvidence(snapshot?.metadata);
      authority = verdict.authority;
    } else if (verdict.kind === "notice" && !decision.publish) {
      decision = { mode: "skip", publish: false, reason: verdict.fenceReason };
    }
  }
  if (decision.mode === "continue") {
    // A continuation carries the interrupted turn's own authority envelope. A
    // snapshot without a readable one (written before this release, or
    // malformed) never continues the turn: its durable queued messages, which
    // carry their own envelopes, are still redelivered (`pending_only`), and
    // only a snapshot with nothing queued becomes a notice.
    if (snapshotAuthority.ok) {
      authority = snapshotAuthority.authority;
    } else if ((snapshot?.pendingMessageCount ?? 0) > 0) {
      decision = { mode: "pending_only", publish: true, reason: "pending_only" };
    } else {
      decision = { mode: "skip", publish: false, reason: snapshotAuthority.reason };
    }
  } else if (decision.mode !== "verify_continue" && snapshotAuthority.ok) {
    authority = snapshotAuthority.authority;
  }
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
      evidence,
      taskBarrierTaskId: cleanString(snapshot?.metadata?.currentTaskBarrierTaskId),
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
      resumedSessionNames: input.resumedSessionNames,
    });
  }

  const source = deps.resolveSource(snapshot);
  payload = withRestartTurnAuthority(payload, authority, source);

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
