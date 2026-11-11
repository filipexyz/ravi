import { isDeepStrictEqual } from "node:util";
import { reportErrorDiagnostic } from "../utils/error-reporting.js";
import { logger } from "../utils/logger.js";
import {
  ChannelBackendRuntimeOwnershipLostError,
  dbGetChannelBackendIngressReceiptByTurnId,
  dbGetChannelBackendRuntimeState,
  dbGetChatMessage,
  dbRecordChannelBackendRuntimeEvent,
  getDb,
  type ChannelBackendIngressReceiptRecord,
  type ChannelBackendRuntimeStateRecord,
  type ChatMessageRecord,
} from "../router/router-db.js";
import type { SlackAutomaticTerminalManifest } from "./slack/automatic-terminal-manifest.js";

type RecordInput = Parameters<typeof dbRecordChannelBackendRuntimeEvent>[0];
type RecordResult = ReturnType<typeof dbRecordChannelBackendRuntimeEvent>;

const MAX_ROUNDS = 2;
const RETRY_DELAY_MS = 100;
const log = logger.child("channels:terminal-projection-recovery");

/** Bounded persistence diagnostics; codes never contain terminal content or raw exceptions. */
export interface TerminalProjectionRecoveryState {
  phase: "persist";
  status: "recorded" | "retry_scheduled" | "retry_exhausted" | "owner_lost" | "non_retryable" | "outcome_unknown";
  round: number;
  maxRounds: number;
  errorCode?: string;
  nextAttemptAt?: number;
}

export interface TerminalProjectionRecoveryOptions {
  /** Additional attempts require this captured owner fence as well as the original mayWrite. */
  mayRecover: () => boolean;
  /** Synchronous observational callback; a diagnostic failure cannot change persistence policy. */
  onState?: (state: TerminalProjectionRecoveryState) => void;
  /** Runs synchronously once after commit confirmation, before this helper yields or resolves. */
  onCommitted?: (result: RecordResult) => void;
}

/** A classified refusal retaining the original persistence failure, never a diagnostic exception. */
export class TerminalProjectionRecoveryError extends Error {
  readonly outcome: TerminalProjectionRecoveryState;
  override readonly cause: unknown;

  constructor(outcome: TerminalProjectionRecoveryState, cause: unknown) {
    super(`Terminal channel persistence: ${outcome.status}`);
    this.name = "TerminalProjectionRecoveryError";
    this.outcome = Object.freeze({ ...outcome });
    this.cause = cause;
  }
}

interface ManifestWitness {
  responseId: string;
  requestFingerprint: string;
  manifest: SlackAutomaticTerminalManifest;
}

interface Snapshot {
  receipt: ChannelBackendIngressReceiptRecord | null;
  runtime: ChannelBackendRuntimeStateRecord | null;
  assistant: ChatMessageRecord | null;
  manifest: ManifestWitness | null;
}

interface Baseline extends Snapshot {
  receipt: ChannelBackendIngressReceiptRecord;
  runtime: ChannelBackendRuntimeStateRecord;
}

type Readback =
  | { kind: "committed"; result: RecordResult }
  | { kind: "unchanged" | "conflict" | "unknown" | "owner_lost" };

/** Distinguishes a changed DB witness from a lost host owner without exposing row contents. */
class TerminalWitnessConflictError extends Error {
  constructor() {
    super("Terminal persistence witness changed");
    this.name = "TerminalWitnessConflictError";
  }
}

/**
 * Persist one frozen terminal operation during its existing owner's inline lifetime.
 * Call after any accepted-to-running bootstrap: that committed sequence is the
 * baseline, and this terminal must advance it exactly once without a new delta.
 * The initial recorder retains its original mayWrite semantics. Only an intact
 * owner, typed SQLite lock refusal and unchanged consistent readback authorize
 * one extra recorder invocation after 100 ms; executeWrite's six attempts are
 * unchanged. Counts are bounded, not the duration of SQLite's existing waits.
 *
 * An uncertain read permits at most one delayed read-only retry, never a blind
 * write. Exact terminal, receipt, canonical message and manifest evidence can
 * confirm an ambiguous commit. Confirmation is latched and its callback runs
 * synchronously outside every DB catch, so callback failures cannot repeat the
 * transaction. This helper neither dispatches output nor owns media cleanup.
 */
export async function recordTerminalProjectionWithRecovery(
  input: RecordInput,
  options: TerminalProjectionRecoveryOptions,
): Promise<RecordResult> {
  const { mayRecover, onState, onCommitted } = options;
  let round = 0;
  let committed = false;

  /** Diagnostics are optional observations, never a second failure or a write request. */
  const notify = (state: TerminalProjectionRecoveryState): void => {
    try {
      onState?.(Object.freeze(state));
    } catch (error) {
      // Preserve the primary operation, including a successful commit.
      reportErrorDiagnostic(log, "Terminal projection observer failed", error, {
        operation: "terminal_projection_observer",
      });
    }
  };

  /** Stop with sanitized phase information while retaining the original cause. */
  const refuse = (status: TerminalProjectionRecoveryState["status"], errorCode: string, cause: unknown): never => {
    const outcome: TerminalProjectionRecoveryState = {
      phase: "persist",
      status,
      round,
      maxRounds: MAX_ROUNDS,
      errorCode,
    };
    notify(outcome);
    throw new TerminalProjectionRecoveryError(outcome, cause);
  };

  let operation: RecordInput;
  try {
    operation = captureOperation(input);
  } catch (cause) {
    return refuse("non_retryable", "INVALID_TERMINAL_OPERATION", cause);
  }

  let initial: Snapshot;
  try {
    initial = readSnapshot(operation);
  } catch (cause) {
    return refuse("outcome_unknown", "BASELINE_UNAVAILABLE", cause);
  }
  if (!initial.receipt || !initial.runtime) {
    return refuse("non_retryable", "PRETERMINAL_WITNESS_MISSING", new TerminalWitnessConflictError());
  }
  if (isTerminal(initial.runtime.state)) {
    return refuse("non_retryable", "ALREADY_TERMINAL", new TerminalWitnessConflictError());
  }
  if (
    initial.receipt.turnId !== operation.turnId ||
    initial.runtime.turnId !== operation.turnId ||
    !Number.isSafeInteger(initial.runtime.lastSequence + 1) ||
    !Number.isSafeInteger(initial.runtime.lastDeltaSequence) ||
    (initial.runtime.assistantMessageId !== undefined && !initial.assistant) ||
    (initial.manifest !== null && !matchesManifest(initial.manifest, operation.slackTerminalManifest))
  ) {
    return refuse("non_retryable", "PRETERMINAL_WITNESS_CONFLICT", new TerminalWitnessConflictError());
  }
  const baseline: Baseline = freezeValue({ ...initial, receipt: initial.receipt, runtime: initial.runtime });

  /** The strict fence governs added work only; explicit-cancellation initial writes remain valid. */
  const ownsRecovery = (): boolean => {
    try {
      return mayRecover() === true && (!operation.mayWrite || operation.mayWrite() === true);
    } catch (error) {
      reportErrorDiagnostic(log, "Terminal projection owner check failed", error, {
        operation: "terminal_projection_owner",
      });
      return false;
    }
  };

  /** Acknowledge before any await; callback exceptions escape unchanged and cannot enter DB recovery. */
  const acknowledge = (result: RecordResult): RecordResult => {
    if (!committed) {
      committed = true;
      try {
        onCommitted?.(result);
      } finally {
        notify({ phase: "persist", status: "recorded", round, maxRounds: MAX_ROUNDS });
      }
    }
    return result;
  };

  /**
   * Read all correlated rows together. After owner loss a synchronous positive
   * read can still settle an already committed operation and release its local
   * ownership; it authorizes neither another timer/write nor fresh dispatch.
   */
  const inspect = (): Readback => {
    const ownedBeforeRead = ownsRecovery();
    let snapshot: Snapshot;
    try {
      snapshot = readSnapshot(operation);
    } catch (error) {
      reportErrorDiagnostic(log, "Terminal projection readback failed", error, {
        operation: "terminal_projection_readback",
      });
      return { kind: ownedBeforeRead && ownsRecovery() ? "unknown" : "owner_lost" };
    }
    const evidence = compareSnapshot(snapshot, baseline, operation);
    if (evidence.kind === "committed") return evidence;
    if (!ownedBeforeRead || !ownsRecovery()) return { kind: "owner_lost" };
    return evidence;
  };

  /** Recheck both fences on every internal DB attempt, including after SQLite's synchronous waits. */
  const mayWriteRecovery = (): boolean => {
    if (!ownsRecovery()) return false;
    // These readers share the recorder's current transaction. Reject a changed
    // preterminal sequence even if another process advanced it after our timer.
    // Later owner checks in that same transaction also see our own terminal
    // update, before its manifest insert; allow only the expected runtime there.
    const receipt = dbGetChannelBackendIngressReceiptByTurnId(operation.turnId);
    const runtime = dbGetChannelBackendRuntimeState(operation.turnId);
    if (
      !receipt ||
      !runtime ||
      !sameReceiptIdentity(receipt, baseline.receipt) ||
      (!isDeepStrictEqual(runtime, baseline.runtime) && !matchesTerminalRuntime(runtime, baseline, operation))
    ) {
      throw new TerminalWitnessConflictError();
    }
    return ownsRecovery();
  };

  /** Schedule only within the retained owner; diagnostics cannot authorize the timer or its next action. */
  const announceRetry = (cause: unknown, errorCode: string): void => {
    if (!ownsRecovery()) refuse("owner_lost", "OWNER_LOST", cause);
    notify({
      phase: "persist",
      status: "retry_scheduled",
      round,
      maxRounds: MAX_ROUNDS,
      errorCode,
      nextAttemptAt: Date.now() + RETRY_DELAY_MS,
    });
    if (!ownsRecovery()) refuse("owner_lost", "OWNER_LOST", cause);
  };

  round = 1;
  let attempt = tryRecord(operation);
  if (attempt.kind === "recorded") return acknowledge(attempt.result);
  let cause = attempt.cause;
  if (cause instanceof ChannelBackendRuntimeOwnershipLostError) return refuse("owner_lost", "OWNER_LOST", cause);
  if (isRecorderRefusal(cause)) return refuse("non_retryable", "PERSISTENCE_REFUSED", cause);
  let evidence = inspect();
  let readbackOnly = false;
  let readbackRetryUsed = false;

  for (;;) {
    if (evidence.kind === "committed") return acknowledge(evidence.result);
    if (evidence.kind === "owner_lost") return refuse("owner_lost", "OWNER_LOST", cause);
    if (evidence.kind === "conflict") return refuse("non_retryable", "TERMINAL_WITNESS_CONFLICT", cause);
    if (evidence.kind === "unknown") {
      if (readbackRetryUsed) return refuse("outcome_unknown", "READBACK_UNAVAILABLE", cause);
      readbackRetryUsed = true;
      readbackOnly = true;
      announceRetry(cause, "READBACK_UNAVAILABLE");
      await waitForRetry();
      if (!ownsRecovery()) return refuse("owner_lost", "OWNER_LOST", cause);
      evidence = inspect();
      continue;
    }
    // Once a read was uncertain, even later absence/unchanged state does not
    // authorize a new transaction. Only positive exact evidence can settle it.
    if (readbackOnly) return refuse("outcome_unknown", "COMMIT_NOT_CONFIRMED", cause);
    const lockCode = sqliteLockCode(cause);
    if (!lockCode) return refuse("non_retryable", "PERSISTENCE_REFUSED", cause);
    if (round >= MAX_ROUNDS) return refuse("retry_exhausted", lockCode, cause);

    announceRetry(cause, lockCode);
    await waitForRetry();
    if (!ownsRecovery()) return refuse("owner_lost", "OWNER_LOST", cause);
    evidence = inspect();
    if (evidence.kind !== "unchanged") continue;
    // The timer does not preserve DB ownership: require a fresh unchanged
    // witness immediately before the extra recorder call as well as inside it.
    round += 1;
    attempt = tryRecord({ ...operation, mayWrite: mayWriteRecovery });
    if (attempt.kind === "recorded") return acknowledge(attempt.result);
    cause = attempt.cause;
    if (cause instanceof ChannelBackendRuntimeOwnershipLostError) return refuse("owner_lost", "OWNER_LOST", cause);
    if (isRecorderRefusal(cause)) return refuse("non_retryable", "PERSISTENCE_REFUSED", cause);
    evidence = inspect();
  }
}

/** Capture serializable values once with the recorder's fixed time, preserving only its original function fence. */
function captureOperation(input: RecordInput): RecordInput {
  const { mayWrite, ...values } = input;
  const occurredAt = input.occurredAt ?? Date.now();
  if (
    !isTerminal(input.state) ||
    input.assistantDelta === true ||
    typeof input.turnId !== "string" ||
    !input.turnId.trim() ||
    typeof input.runtimeGenerationId !== "string" ||
    !input.runtimeGenerationId.trim() ||
    !Number.isSafeInteger(occurredAt) ||
    occurredAt < 0 ||
    (input.assistantText !== undefined &&
      (input.state !== "completed" || typeof input.assistantText !== "string" || !input.assistantText.trim()))
  ) {
    throw new Error("Invalid terminal persistence operation");
  }
  const captured = JSON.parse(JSON.stringify({ ...values, occurredAt })) as RecordInput;
  return freezeValue({ ...captured, mayWrite });
}

/** Freeze only captured data; the caller's original input objects and function identity remain untouched. */
function freezeValue<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeValue(child);
    Object.freeze(value);
  }
  return value;
}

/** Use the same connection's deferred read transaction for receipt, runtime, assistant and manifest. */
function readSnapshot(input: RecordInput): Snapshot {
  const database = getDb();
  // A failed rollback can leave this connection observing its own uncommitted
  // changes. A nested savepoint would make those look consistent but would not
  // prove durability; only begin a read snapshot from a settled connection.
  if (database.inTransaction) throw new Error("Terminal readback requires a settled transaction");
  const snapshot = database
    .transaction(() => {
      const receipt = dbGetChannelBackendIngressReceiptByTurnId(input.turnId);
      const runtime = dbGetChannelBackendRuntimeState(input.turnId);
      const assistant = runtime?.assistantMessageId ? dbGetChatMessage(runtime.assistantMessageId) : null;
      const row = input.slackTerminalManifest
        ? (database
            .prepare(
              "SELECT response_id, request_fingerprint, manifest_json FROM slack_automatic_terminal_manifests WHERE response_id = ?",
            )
            .get(input.slackTerminalManifest.responseId) as {
            response_id: string;
            request_fingerprint: string;
            manifest_json: string;
          } | null)
        : null;
      const manifest = row
        ? {
            responseId: row.response_id,
            requestFingerprint: row.request_fingerprint,
            manifest: JSON.parse(row.manifest_json) as SlackAutomaticTerminalManifest,
          }
        : null;
      return { receipt, runtime, assistant, manifest };
    })
    .deferred();
  if (database.inTransaction) throw new Error("Terminal readback transaction did not settle");
  return snapshot;
}

/** Separate recorder exceptions from commit callbacks, which must never be caught as DB failures. */
function tryRecord(
  input: RecordInput,
): { kind: "recorded"; result: RecordResult } | { kind: "failed"; cause: unknown } {
  try {
    return { kind: "recorded", result: dbRecordChannelBackendRuntimeEvent(input) };
  } catch (cause) {
    return { kind: "failed", cause };
  }
}

/** Exact positive evidence confirms commit; missing rows are uncertainty, never proof of rollback. */
function compareSnapshot(snapshot: Snapshot, baseline: Baseline, input: RecordInput): Readback {
  const { receipt, runtime, assistant, manifest } = snapshot;
  if (!receipt || !runtime) return { kind: "unknown" };
  if (!sameReceiptIdentity(receipt, baseline.receipt)) return { kind: "conflict" };
  if (isDeepStrictEqual(runtime, baseline.runtime)) {
    if (!isDeepStrictEqual(assistant, baseline.assistant) || !isDeepStrictEqual(manifest, baseline.manifest)) {
      return { kind: "conflict" };
    }
    return { kind: "unchanged" };
  }
  if (!matchesTerminalRuntime(runtime, baseline, input)) return { kind: "conflict" };
  if (input.assistantText !== undefined) {
    if (!assistant) return { kind: "unknown" };
    if (!matchesAssistant(assistant, runtime, receipt, input)) return { kind: "conflict" };
  } else if (!isDeepStrictEqual(assistant, baseline.assistant)) {
    return { kind: assistant === null && baseline.assistant !== null ? "unknown" : "conflict" };
  }
  if (input.slackTerminalManifest) {
    if (!manifest) return { kind: "unknown" };
    if (!matchesManifest(manifest, input.slackTerminalManifest)) return { kind: "conflict" };
  }
  return {
    kind: "committed",
    result: { receipt, runtime, ...(manifest ? { slackTerminalManifest: manifest.manifest } : {}) },
  };
}

/** Compare the accepted binding and request, excluding independently mutable ingress publication bookkeeping. */
function sameReceiptIdentity(
  left: ChannelBackendIngressReceiptRecord,
  right: ChannelBackendIngressReceiptRecord,
): boolean {
  return isDeepStrictEqual(receiptIdentity(left), receiptIdentity(right));
}

/** Preserve every accepted identity and prompt field without pinning the ingress publisher's lease/state. */
function receiptIdentity(receipt: ChannelBackendIngressReceiptRecord): Record<string, unknown> {
  return {
    id: receipt.id,
    channelInstanceId: receipt.channelInstanceId,
    idempotencyKey: receipt.idempotencyKey,
    requestFingerprint: receipt.requestFingerprint,
    initialRequestId: receipt.initialRequestId,
    localActorId: receipt.localActorId,
    agentId: receipt.agentId,
    chatId: receipt.chatId,
    messageId: receipt.messageId,
    sessionKey: receipt.sessionKey,
    sessionName: receipt.sessionName,
    turnId: receipt.turnId,
    external: receipt.external,
    prompt: receipt.prompt,
    acceptedAt: receipt.acceptedAt,
  };
}

/** The terminal is exactly the frozen baseline plus one event and no delta, including persisted error semantics. */
function matchesTerminalRuntime(
  runtime: ChannelBackendRuntimeStateRecord,
  baseline: Baseline,
  input: RecordInput,
): boolean {
  return (
    runtime.turnId === input.turnId &&
    runtime.state === input.state &&
    runtime.lastSequence === baseline.runtime.lastSequence + 1 &&
    runtime.lastDeltaSequence === baseline.runtime.lastDeltaSequence &&
    runtime.runtimeGenerationId === input.runtimeGenerationId &&
    runtime.updatedAt === input.occurredAt &&
    isDeepStrictEqual(runtime.terminalError, input.terminalError ?? baseline.runtime.terminalError) &&
    (input.assistantText === undefined
      ? runtime.assistantMessageId === baseline.runtime.assistantMessageId
      : typeof runtime.assistantMessageId === "string" && runtime.assistantMessageId.length > 0)
  );
}

/** Verify the runtime's canonical pointer and complete authored content/provenance without duplicating private ID derivation. */
function matchesAssistant(
  message: ChatMessageRecord,
  runtime: ChannelBackendRuntimeStateRecord,
  receipt: ChannelBackendIngressReceiptRecord,
  input: RecordInput,
): boolean {
  return (
    message.id === runtime.assistantMessageId &&
    message.chatId === receipt.chatId &&
    message.channel === receipt.external.channelKind &&
    message.instanceId === receipt.channelInstanceId &&
    message.rawChatId === receipt.external.conversationId &&
    message.rawSenderId === receipt.agentId &&
    message.normalizedSenderId === receipt.agentId &&
    message.actorType === "agent" &&
    message.agentId === receipt.agentId &&
    message.originSessionKey === receipt.sessionKey &&
    message.messageType === "text" &&
    typeof message.providerMessageId === "string" &&
    message.providerMessageId.length > 0 &&
    message.actorId === undefined &&
    message.clientMessageId === undefined &&
    message.contactId === undefined &&
    message.platformIdentityId === undefined &&
    message.editedAt === undefined &&
    message.deletedAt === undefined &&
    message.providerTimestamp === input.occurredAt &&
    message.ingestedAt === input.occurredAt &&
    message.createdAt === input.occurredAt &&
    message.updatedAt === input.occurredAt &&
    isDeepStrictEqual(message.content, { blocks: [{ type: "text", text: input.assistantText?.trim() }] }) &&
    isDeepStrictEqual(message.rawProvenance, { source: "channel.runtime", turnId: input.turnId })
  );
}

/** Check both persisted index identity and every prepared manifest field, including all ordered media hashes. */
function matchesManifest(saved: ManifestWitness, prepared: SlackAutomaticTerminalManifest | undefined): boolean {
  return (
    prepared !== undefined &&
    saved.responseId === prepared.responseId &&
    saved.requestFingerprint === prepared.requestFingerprint &&
    isDeepStrictEqual(saved.manifest, prepared)
  );
}

/** Known recorder validation/transition refusals cannot be relabeled as this call's ambiguous commit. */
function isRecorderRefusal(cause: unknown): boolean {
  if (cause instanceof TerminalWitnessConflictError) return true;
  if (!(cause instanceof Error)) return false;
  return (
    /^Channel runtime turn (?:is already terminal: |already recorded terminal state )(?:completed|failed|interrupted)$/.test(
      cause.message,
    ) ||
    cause.message === "Slack terminal manifest does not match the channel runtime transition" ||
    cause.message === "Slack automatic terminal manifest identity conflict" ||
    cause.message === "assistantText is valid only for a completed channel runtime turn" ||
    cause.message === "assistantText must not be empty" ||
    cause.message === "occurredAt must be a non-negative Unix millisecond timestamp"
  );
}

/** Recognize only typed SQLite BUSY/LOCKED primary or known extended codes, never error-message substrings. */
function sqliteLockCode(cause: unknown): "SQLITE_BUSY" | "SQLITE_LOCKED" | undefined {
  if (!(cause instanceof Error)) return undefined;
  const error = cause as Error & { code?: unknown; errno?: unknown };
  if (
    error.code === "SQLITE_BUSY" ||
    error.code === "SQLITE_BUSY_RECOVERY" ||
    error.code === "SQLITE_BUSY_SNAPSHOT" ||
    error.code === "SQLITE_BUSY_TIMEOUT"
  )
    return "SQLITE_BUSY";
  if (
    error.code === "SQLITE_LOCKED" ||
    error.code === "SQLITE_LOCKED_SHAREDCACHE" ||
    error.code === "SQLITE_LOCKED_VTAB"
  )
    return "SQLITE_LOCKED";
  if (error.code !== undefined) return undefined;
  if (error.errno === 5 || error.errno === 261 || error.errno === 517 || error.errno === 773) return "SQLITE_BUSY";
  if (error.errno === 6 || error.errno === 262 || error.errno === 518) return "SQLITE_LOCKED";
  return undefined;
}

/** Terminal recovery never advances accepted/running/approval events. */
function isTerminal(state: RecordInput["state"]): boolean {
  return state === "completed" || state === "failed" || state === "interrupted";
}

/** Yield to the actual event loop without introducing a detached scheduler or changing SQLite's retry policy. */
function waitForRetry(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
}
