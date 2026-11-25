/**
 * Resume turns that a daemon restart cut off.
 *
 * The graceful shutdown records a restart snapshot, but only when it gets to
 * run: PM2 sends SIGKILL after its kill timeout, a fatal ownership error calls
 * `process.exit(1)`, and a crash runs nothing at all. In every one of those
 * cases the durable crash-recovery ledger still holds the truth: the previous
 * boot epoch stays `active` and the turn attempts it owned stay `running`.
 *
 * This module turns that ledger into one bounded action per interrupted turn:
 * - the previous boot must be provably dead: its lease expired, and it is
 *   fenced by abandoning it with the observed heartbeat/lease (the ledger
 *   refuses to abandon a boot before its lease expires, so a boot found right
 *   after a restart is retried once its lease runs out);
 * - only the newest interrupted attempt of each session counts, and only when
 *   the session started nothing after it;
 * - the attempt is terminalized and marked before anything is published, so it
 *   is resumed at most once (`markRuntimeTurnAttemptRestartRecovery`);
 * - the resume never replays the original input: the session gets a note that
 *   the daemon restarted mid-turn and must check the real state before
 *   repeating any action;
 * - a turn that was itself a restart resume gets a notice instead, so a turn
 *   that crashes the daemon cannot loop.
 */
import type { RuntimeBootEpochRecord, RuntimeTurnAttemptRecord } from "./crash-recovery-store.js";
import type { RuntimeTurnAttemptRestartRecoveryStatus } from "./crash-recovery-store.js";

/** Origins whose interrupted turn is conversational work worth continuing. */
const RESUMABLE_TURN_ORIGINS = new Set<string>(["human", "agent", "task", "unknown"]);

export type RestartAttemptClaim =
  | { kind: "resume"; attempt: RuntimeTurnAttemptRecord }
  | { kind: "loop"; attempt: RuntimeTurnAttemptRecord }
  | { kind: "skip"; reason: RestartAttemptSkipReason; attempt?: RuntimeTurnAttemptRecord };

export type RestartAttemptSkipReason =
  | "attempt_missing"
  | "already_recovered"
  | "superseded"
  | "turn_completed"
  | "origin_not_resumable"
  | "claim_conflict";

export interface RestartAttemptStore {
  getAttempt(attemptId: string): RuntimeTurnAttemptRecord | null;
  hasLaterAttempt(attempt: RuntimeTurnAttemptRecord): boolean;
  /** Compare-and-set `running` → `interrupted`; false when another writer won. */
  terminalizeInterrupted(attempt: RuntimeTurnAttemptRecord, completedAt: number): boolean;
  /** Compare-and-set the at-most-once restart recovery marker. */
  markRecovery(attemptId: string, status: RuntimeTurnAttemptRestartRecoveryStatus, reason: string, at: number): boolean;
}

/**
 * Claim one interrupted attempt for restart recovery. The caller must already
 * know that the attempt's owner is gone (dead boot epoch, or a graceful
 * shutdown that recorded it in its snapshot).
 */
export function claimRestartInterruptedAttempt(
  input: { attemptId: string; now: number },
  store: RestartAttemptStore,
): RestartAttemptClaim {
  let attempt = store.getAttempt(input.attemptId);
  if (!attempt) {
    return { kind: "skip", reason: "attempt_missing" };
  }
  if (attempt.recoveryStatus !== null || attempt.recoveryClaimId !== null) {
    return { kind: "skip", reason: "already_recovered", attempt };
  }
  if (attempt.status === "complete" || attempt.status === "failed" || attempt.status === "timeout") {
    // The provider finished this turn (successfully or not): there is nothing
    // interrupted to continue, and a failure has its own reporting path.
    store.markRecovery(attempt.attemptId, "restart_skipped", "turn_completed", input.now);
    return { kind: "skip", reason: "turn_completed", attempt };
  }
  if (attempt.status === "running") {
    store.terminalizeInterrupted(attempt, Math.max(input.now, attempt.lastHeartbeatAt, attempt.updatedAt));
    attempt = store.getAttempt(input.attemptId);
    if (!attempt || attempt.status === "running") {
      return { kind: "skip", reason: "claim_conflict", ...(attempt ? { attempt } : {}) };
    }
    if (attempt.status !== "interrupted" && attempt.status !== "aborted") {
      return { kind: "skip", reason: "claim_conflict", attempt };
    }
  }

  if (store.hasLaterAttempt(attempt)) {
    store.markRecovery(attempt.attemptId, "restart_skipped", "superseded", input.now);
    return { kind: "skip", reason: "superseded", attempt };
  }
  if (attempt.originKind === "daemon-restart") {
    // This turn was itself a restart resume and the daemon went down again:
    // resuming once more could loop on whatever brought the daemon down.
    return store.markRecovery(attempt.attemptId, "restart_noticed", "resume_loop", input.now)
      ? { kind: "loop", attempt }
      : { kind: "skip", reason: "already_recovered", attempt };
  }
  if (!RESUMABLE_TURN_ORIGINS.has(attempt.originKind)) {
    store.markRecovery(attempt.attemptId, "restart_skipped", `origin_${attempt.originKind}`, input.now);
    return { kind: "skip", reason: "origin_not_resumable", attempt };
  }
  return store.markRecovery(attempt.attemptId, "restart_resumed", "verify_continue", input.now)
    ? { kind: "resume", attempt }
    : { kind: "skip", reason: "already_recovered", attempt };
}

export interface OrphanedRestartTurnDeps extends RestartAttemptStore {
  now(): number;
  listActiveBootEpochs(): RuntimeBootEpochRecord[];
  /** Fence a dead boot: compare-and-set `active` → `abandoned` on the observed heartbeat/lease. */
  abandonBootEpoch(boot: RuntimeBootEpochRecord, at: number): boolean;
  listRunningAttempts(bootEpoch: string): RuntimeTurnAttemptRecord[];
  hasDelivery(restartEpoch: string, sessionKey: string): boolean;
  /** Resolve the live session for an attempt; null when the session no longer exists. */
  resolveSessionName(attempt: RuntimeTurnAttemptRecord): string | null;
  isTerminalTaskSession(sessionName: string, taskBarrierTaskId: string | null): boolean;
  /** Publish the resume (`claim.kind === "resume"`) or the loop notice for one attempt. */
  deliver(input: { claim: RestartAttemptClaim & { kind: "resume" | "loop" }; sessionName: string }): Promise<boolean>;
}

export interface OrphanedRestartTurnOutcome {
  resumed: string[];
  noticed: string[];
  skipped: Array<{ sessionKey: string; attemptId: string; reason: string }>;
  /** When a candidate boot could not be proven dead yet, its lease expiry. */
  retryAt: number | null;
  /** Sessions whose interrupted turn waits for that lease expiry. */
  pending: string[];
}

/**
 * Recover the turns left `running` by boot epochs that died without a graceful
 * stop, within `windowMs` of their last heartbeat.
 */
export async function recoverOrphanedRestartTurns(
  input: { restartEpoch: string; currentBootEpoch: string | null; windowMs: number },
  deps: OrphanedRestartTurnDeps,
): Promise<OrphanedRestartTurnOutcome> {
  const outcome: OrphanedRestartTurnOutcome = { resumed: [], noticed: [], skipped: [], retryAt: null, pending: [] };
  if (!input.currentBootEpoch) {
    // Without our own boot epoch we cannot tell our attempts from a dead boot's.
    return outcome;
  }
  const startedAt = deps.now();
  const deadBoots: RuntimeBootEpochRecord[] = [];
  for (const boot of deps.listActiveBootEpochs()) {
    if (boot.bootEpoch === input.currentBootEpoch || boot.lastHeartbeatAt < startedAt - input.windowMs) {
      continue;
    }
    if (boot.leaseExpiresAt > startedAt) {
      // Still inside its lease: the owner may be alive, and the ledger will not
      // let us fence it yet. Report what waits and look again at expiry.
      const waiting = deps.listRunningAttempts(boot.bootEpoch);
      if (waiting.length > 0) {
        outcome.retryAt = Math.max(outcome.retryAt ?? 0, boot.leaseExpiresAt);
        for (const attempt of waiting) {
          const name = attempt.sessionName ?? attempt.sessionKey;
          if (!outcome.pending.includes(name)) outcome.pending.push(name);
        }
      }
      continue;
    }
    if (deps.abandonBootEpoch(boot, startedAt)) {
      deadBoots.push(boot);
    }
  }

  const newestBySession = new Map<string, RuntimeTurnAttemptRecord>();
  const olderAttempts: RuntimeTurnAttemptRecord[] = [];
  for (const boot of deadBoots) {
    for (const attempt of deps.listRunningAttempts(boot.bootEpoch)) {
      const current = newestBySession.get(attempt.sessionKey);
      if (!current || isLaterAttempt(attempt, current)) {
        if (current) olderAttempts.push(current);
        newestBySession.set(attempt.sessionKey, attempt);
      } else {
        olderAttempts.push(attempt);
      }
    }
  }

  for (const attempt of olderAttempts) {
    const claim = claimRestartInterruptedAttempt({ attemptId: attempt.attemptId, now: deps.now() }, deps);
    outcome.skipped.push({ sessionKey: attempt.sessionKey, attemptId: attempt.attemptId, reason: skipReason(claim) });
  }

  for (const attempt of newestBySession.values()) {
    const skip = (reason: string) =>
      outcome.skipped.push({ sessionKey: attempt.sessionKey, attemptId: attempt.attemptId, reason });
    const now = deps.now();
    if (deps.hasDelivery(input.restartEpoch, attempt.sessionKey)) {
      // The restart snapshot already resumed or notified this session.
      deps.terminalizeInterrupted(attempt, Math.max(now, attempt.lastHeartbeatAt, attempt.updatedAt));
      deps.markRecovery(attempt.attemptId, "restart_skipped", "restart_event_delivered", now);
      skip("restart_event_delivered");
      continue;
    }
    const sessionName = deps.resolveSessionName(attempt);
    if (!sessionName || deps.isTerminalTaskSession(sessionName, attempt.taskBarrierTaskId)) {
      const reason = sessionName ? "terminal_task" : "session_missing";
      deps.terminalizeInterrupted(attempt, Math.max(now, attempt.lastHeartbeatAt, attempt.updatedAt));
      deps.markRecovery(attempt.attemptId, "restart_skipped", reason, now);
      skip(reason);
      continue;
    }
    const claim = claimRestartInterruptedAttempt({ attemptId: attempt.attemptId, now }, deps);
    if (claim.kind === "skip") {
      skip(claim.reason);
      continue;
    }
    const delivered = await deps.deliver({ claim, sessionName });
    if (!delivered) {
      skip("publish_failed");
      continue;
    }
    (claim.kind === "resume" ? outcome.resumed : outcome.noticed).push(sessionName);
  }
  return outcome;
}

function isLaterAttempt(candidate: RuntimeTurnAttemptRecord, current: RuntimeTurnAttemptRecord): boolean {
  return (
    candidate.startedAt > current.startedAt ||
    (candidate.startedAt === current.startedAt && candidate.attemptId > current.attemptId)
  );
}

function skipReason(claim: RestartAttemptClaim): string {
  return claim.kind === "skip" ? claim.reason : claim.kind;
}

/** Evidence that the interrupted turn had already started acting. */
export function describeInterruptedAttemptEvidence(
  attempt: Pick<RuntimeTurnAttemptRecord, "startedTool" | "materializedOutput">,
): string[] {
  const evidence: string[] = [];
  if (attempt.startedTool) evidence.push("ferramenta já iniciada");
  if (attempt.materializedOutput) evidence.push("resposta já emitida");
  return evidence;
}
