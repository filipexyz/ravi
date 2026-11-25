/**
 * Resume turns that a daemon restart cut off.
 *
 * The graceful shutdown records a restart snapshot, but only when it gets to
 * run: PM2 sends SIGKILL after its kill timeout, a fatal ownership error calls
 * `process.exit(1)`, and a crash runs nothing at all. In every one of those
 * cases the durable crash-recovery ledger still holds the truth: the previous
 * boot epoch stays `active` and the turn attempts it owned stay `running`.
 *
 * Recovery follows the ledger's own contract (crash-recovery SPEC, "Recovery
 * Policy"):
 * - a boot is only fenced (compare-and-set to `abandoned` on the observed
 *   heartbeat/lease) after its lease expired; a boot still inside its lease is
 *   retried once its lease runs out;
 * - candidates are expired, unclaimed `running` attempts of abandoned boots,
 *   recorded in a durable `apply` recovery run and claimed before any action,
 *   so each attempt is acted on at most once across boots, passes and daemons;
 * - only the newest attempt of each session counts, and only when the session
 *   started nothing after it;
 * - a resume never replays the original input: the session gets a note that
 *   the daemon restarted mid-turn and must check the real state before
 *   repeating any action (`verify_continue`);
 * - a turn that was itself a restart resume gets a notice instead, so a turn
 *   that brings the daemon down cannot loop.
 */
import { logger } from "../utils/logger.js";
import {
  buildDaemonRestartNoticePrompt,
  buildDaemonRestartResumePrompt,
  type DaemonRestartPrompt,
  type DaemonRestartResumeFenceReason,
  normalizeRestartResumeSource,
  RESTART_TURN_AUTHORITY_METADATA_KEY,
  type RestoredRestartTurnAuthority,
  restoreRestartTurnAuthority,
  withRestartTurnAuthority,
} from "./daemon-restart-resume.js";
import type { RuntimeProviderId } from "./types.js";
import {
  acquireRuntimeRecoveryClaim,
  buildRuntimeRecoveryCandidateKey,
  completeRuntimeRecoveryClaim,
  completeRuntimeRecoveryRun,
  createRuntimeRecoveryRun,
  hasLaterRuntimeTurnAttempt,
  listRuntimeBootEpochs,
  listRuntimeTurnAttempts,
  markRuntimeBootEpochAbandoned,
  recordRuntimeRecoveryCandidate,
  type RuntimeBootEpochRecord,
  type RuntimeRecoveryDecision,
  type RuntimeTurnAttemptRecord,
} from "./crash-recovery-store.js";

const log = logger.child("runtime:restart-turn-recovery");

/** Origins whose interrupted turn is conversational work worth continuing. */
const RESUMABLE_TURN_ORIGINS = new Set<string>(["human", "agent", "task", "unknown"]);
/** Scheduled origins defer to their next run instead of resuming (SPEC: recurring work). */
const SCHEDULED_TURN_ORIGINS = new Set<string>([
  "cron",
  "trigger",
  "heartbeat",
  "session-followup",
  "routine",
  "automation",
]);

/** Attempt metadata written by the request builder when a turn starts from a restart resume. */
export const RESTART_RESUME_ATTEMPT_METADATA_KEY = "restartResume";

export function isRestartResumeAttempt(attempt: Pick<RuntimeTurnAttemptRecord, "originKind" | "metadata">): boolean {
  return attempt.originKind === "daemon-restart" || attempt.metadata?.[RESTART_RESUME_ATTEMPT_METADATA_KEY] === true;
}

export type RestartAttemptSkipReason =
  | "attempt_missing"
  | "turn_completed"
  | "superseded"
  | "origin_scheduled"
  | "origin_not_resumable";

type RestoredAuthority = Extract<RestoredRestartTurnAuthority, { ok: true }>["authority"];

export type RestartAttemptNoticeReason = Extract<
  DaemonRestartResumeFenceReason,
  "resume_loop" | "authority_missing" | "authority_unreadable" | "authority_automation"
>;

export type RestartAttemptVerdict =
  | { kind: "resume"; attempt: RuntimeTurnAttemptRecord; authority: RestoredAuthority }
  | {
      kind: "notice";
      attempt: RuntimeTurnAttemptRecord;
      fenceReason: RestartAttemptNoticeReason;
      authority?: RestoredAuthority;
    }
  | { kind: "skip"; reason: RestartAttemptSkipReason; attempt?: RuntimeTurnAttemptRecord };

/**
 * Decide, without writing anything, what a restart should do with one
 * interrupted attempt. The caller must already know the attempt's owner is
 * gone (an abandoned boot, or a graceful shutdown that recorded it).
 */
export function judgeRestartInterruptedAttempt(
  attempt: RuntimeTurnAttemptRecord | null,
  reader: { hasLaterAttempt(attempt: RuntimeTurnAttemptRecord): boolean },
): RestartAttemptVerdict {
  if (!attempt) {
    return { kind: "skip", reason: "attempt_missing" };
  }
  if (attempt.status === "complete" || attempt.status === "failed" || attempt.status === "timeout") {
    // The provider finished this turn: nothing interrupted to continue, and a
    // failure has its own reporting path.
    return { kind: "skip", reason: "turn_completed", attempt };
  }
  if (reader.hasLaterAttempt(attempt)) {
    return { kind: "skip", reason: "superseded", attempt };
  }
  const restored = restoreRestartTurnAuthority(attempt.metadata?.[RESTART_TURN_AUTHORITY_METADATA_KEY]);
  if (isRestartResumeAttempt(attempt)) {
    // This turn was itself a restart resume and the daemon went down again:
    // resuming once more could loop on whatever brought the daemon down.
    return {
      kind: "notice",
      attempt,
      fenceReason: "resume_loop",
      ...(restored.ok ? { authority: restored.authority } : {}),
    };
  }
  if (SCHEDULED_TURN_ORIGINS.has(attempt.originKind)) {
    return { kind: "skip", reason: "origin_scheduled", attempt };
  }
  if (!RESUMABLE_TURN_ORIGINS.has(attempt.originKind)) {
    return { kind: "skip", reason: "origin_not_resumable", attempt };
  }
  if (!restored.ok) {
    // Without the turn's own authority envelope (an attempt recorded before
    // this release, or a malformed one) a resume could act with more than the
    // turn had: fail closed to a notice.
    return { kind: "notice", attempt, fenceReason: restored.reason };
  }
  return { kind: "resume", attempt, authority: restored.authority };
}

/**
 * The restart input for one claimed orphaned attempt: the verify note (or the
 * notice) with the turn's recorded authority envelope and its recorded source.
 */
export function buildOrphanedRestartTurnInput(input: {
  restartEpoch: string;
  reason: string;
  verdict: RestartAttemptVerdict & { kind: "resume" | "notice" };
}): DaemonRestartPrompt {
  const { verdict } = input;
  const attempt = verdict.attempt;
  const runtimeProvider = attempt.provider as RuntimeProviderId;
  const payload =
    verdict.kind === "resume"
      ? buildDaemonRestartResumePrompt({
          restartEpoch: input.restartEpoch,
          reason: input.reason,
          sessionKey: attempt.sessionKey,
          mode: "verify_continue",
          runtimeProvider,
          evidence: describeInterruptedAttemptEvidence(attempt),
          taskBarrierTaskId: attempt.taskBarrierTaskId ?? undefined,
        })
      : buildDaemonRestartNoticePrompt({
          restartEpoch: input.restartEpoch,
          reason: input.reason,
          sessionKey: attempt.sessionKey,
          fenceReason: verdict.fenceReason,
          runtimeProvider,
        });
  const sourceRecord =
    attempt.source && typeof attempt.source === "object" && !Array.isArray(attempt.source)
      ? (attempt.source as Record<string, unknown>)
      : undefined;
  return withRestartTurnAuthority(
    payload,
    verdict.authority,
    sourceRecord ? normalizeRestartResumeSource(sourceRecord) : undefined,
  );
}

interface RecoveryPlan {
  decision: RuntimeRecoveryDecision;
  reasonCode: string;
  action: "publish_verify_continue" | "publish_restart_notice" | "none";
  verdict?: RestartAttemptVerdict & { kind: "resume" | "notice" };
}

export interface OrphanedRestartTurnDeps {
  now(): number;
  /** Boots that may own orphaned attempts: `active` and `abandoned`. */
  listBootEpochs(): RuntimeBootEpochRecord[];
  /** Fence a dead boot: compare-and-set `active` → `abandoned` on the observed heartbeat/lease. */
  abandonBootEpoch(boot: RuntimeBootEpochRecord, at: number): boolean;
  listRunningAttempts(bootEpoch: string): RuntimeTurnAttemptRecord[];
  hasLaterAttempt(attempt: RuntimeTurnAttemptRecord): boolean;
  hasDelivery(restartEpoch: string, sessionKey: string): boolean;
  /** The live session for an attempt; null when the session no longer exists. */
  resolveSessionName(attempt: RuntimeTurnAttemptRecord): string | null;
  /** Whether the attempt's dedicated task is no longer active. */
  isTerminalTaskSession(sessionName: string, taskBarrierTaskId: string | null): boolean;
  startRecoveryRun(): { recoveryRunId: string };
  recordCandidate(input: {
    recoveryRunId: string;
    attempt: RuntimeTurnAttemptRecord;
    decision: RuntimeRecoveryDecision;
    reasonCode: string;
    action: string;
  }): void;
  /** Acquire the global claim for the attempt; null when another run already holds it. */
  claimCandidate(input: { recoveryRunId: string; attempt: RuntimeTurnAttemptRecord }): { claimId: string } | null;
  completeClaim(input: { claimId: string; status: "applied" | "failed"; result: Record<string, unknown> }): void;
  completeRecoveryRun(input: { recoveryRunId: string; summary: Record<string, unknown> }): void;
  /** Publish the resume or the loop notice for one claimed attempt. */
  deliver(input: {
    verdict: RestartAttemptVerdict & { kind: "resume" | "notice" };
    sessionName: string;
  }): Promise<boolean>;
}

export interface OrphanedRestartTurnOutcome {
  recoveryRunId: string | null;
  resumed: string[];
  noticed: string[];
  skipped: Array<{ sessionKey: string; attemptId: string; reason: string }>;
  /** When a candidate boot is still inside its lease, its lease expiry. */
  retryAt: number | null;
  /** Session names whose interrupted turn waits for that lease expiry. */
  pending: string[];
  /** Session keys whose interrupted turn waits for that lease expiry. */
  pendingSessionKeys: string[];
}

interface OrphanScan {
  ready: RuntimeTurnAttemptRecord[];
  waitingBoots: RuntimeBootEpochRecord[];
  waitingAttempts: RuntimeTurnAttemptRecord[];
}

function isWithinWindow(
  boot: RuntimeBootEpochRecord,
  input: { currentBootEpoch: string; windowMs: number },
  now: number,
) {
  return boot.bootEpoch !== input.currentBootEpoch && boot.lastHeartbeatAt >= now - input.windowMs;
}

function isOrphanCandidate(attempt: RuntimeTurnAttemptRecord, now: number): boolean {
  return attempt.status === "running" && attempt.recoveryClaimId === null && attempt.leaseExpiresAt <= now;
}

function scanOrphanedRestartTurns(
  input: { currentBootEpoch: string; windowMs: number },
  deps: Pick<OrphanedRestartTurnDeps, "now" | "listBootEpochs" | "abandonBootEpoch" | "listRunningAttempts">,
  options: { fence: boolean },
): OrphanScan {
  const now = deps.now();
  const scan: OrphanScan = { ready: [], waitingBoots: [], waitingAttempts: [] };
  for (const boot of deps.listBootEpochs()) {
    if (!isWithinWindow(boot, input, now)) continue;
    if (boot.status === "active") {
      if (boot.leaseExpiresAt > now) {
        // Still inside its lease: the owner may be alive, and the ledger will
        // not let us fence it yet. Look again at expiry.
        const waiting = deps.listRunningAttempts(boot.bootEpoch).filter((attempt) => attempt.recoveryClaimId === null);
        if (waiting.length > 0) {
          scan.waitingBoots.push(boot);
          scan.waitingAttempts.push(...waiting);
        }
        continue;
      }
      if (!options.fence) {
        scan.ready.push(
          ...deps.listRunningAttempts(boot.bootEpoch).filter((attempt) => isOrphanCandidate(attempt, now)),
        );
        continue;
      }
      if (!deps.abandonBootEpoch(boot, now)) continue;
    } else if (boot.status !== "abandoned") {
      continue;
    }
    // An abandoned boot (fenced now, or by an earlier pass that may have died
    // halfway) still owns any attempt nobody claimed.
    scan.ready.push(...deps.listRunningAttempts(boot.bootEpoch).filter((attempt) => isOrphanCandidate(attempt, now)));
  }
  return scan;
}

/** Whether any recent dead or still-leased boot left a turn running (no writes). */
export function hasOrphanedRestartTurns(
  input: { currentBootEpoch: string | null; windowMs: number },
  deps: Pick<OrphanedRestartTurnDeps, "now" | "listBootEpochs" | "abandonBootEpoch" | "listRunningAttempts">,
): boolean {
  if (!input.currentBootEpoch) return false;
  const scan = scanOrphanedRestartTurns({ currentBootEpoch: input.currentBootEpoch, windowMs: input.windowMs }, deps, {
    fence: false,
  });
  return scan.ready.length > 0 || scan.waitingAttempts.length > 0;
}

/**
 * Recover the turns left `running` by boots that died without a graceful stop,
 * within `windowMs` of their last heartbeat.
 */
export async function recoverOrphanedRestartTurns(
  input: { restartEpoch: string; currentBootEpoch: string | null; windowMs: number },
  deps: OrphanedRestartTurnDeps,
): Promise<OrphanedRestartTurnOutcome> {
  const outcome: OrphanedRestartTurnOutcome = {
    recoveryRunId: null,
    resumed: [],
    noticed: [],
    skipped: [],
    retryAt: null,
    pending: [],
    pendingSessionKeys: [],
  };
  if (!input.currentBootEpoch) {
    // Without our own boot epoch we can neither tell our attempts apart nor claim.
    return outcome;
  }
  const scan = scanOrphanedRestartTurns({ currentBootEpoch: input.currentBootEpoch, windowMs: input.windowMs }, deps, {
    fence: true,
  });
  for (const boot of scan.waitingBoots) {
    outcome.retryAt = Math.max(outcome.retryAt ?? 0, boot.leaseExpiresAt);
  }
  for (const attempt of scan.waitingAttempts) {
    if (!outcome.pendingSessionKeys.includes(attempt.sessionKey)) {
      outcome.pendingSessionKeys.push(attempt.sessionKey);
      outcome.pending.push(attempt.sessionName ?? attempt.sessionKey);
    }
  }
  if (scan.ready.length === 0) {
    return outcome;
  }

  const newestBySession = new Map<string, RuntimeTurnAttemptRecord>();
  const superseded: RuntimeTurnAttemptRecord[] = [];
  for (const attempt of scan.ready) {
    const current = newestBySession.get(attempt.sessionKey);
    if (!current || isLaterAttempt(attempt, current)) {
      if (current) superseded.push(current);
      newestBySession.set(attempt.sessionKey, attempt);
    } else {
      superseded.push(attempt);
    }
  }

  const { recoveryRunId } = deps.startRecoveryRun();
  outcome.recoveryRunId = recoveryRunId;
  const plans: Array<{ attempt: RuntimeTurnAttemptRecord; plan: RecoveryPlan; sessionName: string | null }> = [];
  for (const attempt of superseded) {
    plans.push({
      attempt,
      sessionName: null,
      plan: { decision: "ignore_stale", reasonCode: "superseded", action: "none" },
    });
  }
  for (const attempt of newestBySession.values()) {
    const sessionName = deps.resolveSessionName(attempt);
    plans.push({ attempt, sessionName, plan: planRecovery(input.restartEpoch, attempt, sessionName, deps) });
  }

  for (const { attempt, plan, sessionName } of plans) {
    try {
      deps.recordCandidate({
        recoveryRunId,
        attempt,
        decision: plan.decision,
        reasonCode: plan.reasonCode,
        action: plan.action,
      });
      const claim = deps.claimCandidate({ recoveryRunId, attempt });
      if (!claim) {
        outcome.skipped.push({
          sessionKey: attempt.sessionKey,
          attemptId: attempt.attemptId,
          reason: "claimed_elsewhere",
        });
        continue;
      }
      let delivered = true;
      if (plan.verdict && sessionName) {
        delivered = await deps.deliver({ verdict: plan.verdict, sessionName });
      }
      deps.completeClaim({
        claimId: claim.claimId,
        status: delivered ? "applied" : "failed",
        result: { action: plan.action, reasonCode: plan.reasonCode, delivered, restartEpoch: input.restartEpoch },
      });
      if (!plan.verdict) {
        outcome.skipped.push({ sessionKey: attempt.sessionKey, attemptId: attempt.attemptId, reason: plan.reasonCode });
      } else if (!delivered) {
        outcome.skipped.push({
          sessionKey: attempt.sessionKey,
          attemptId: attempt.attemptId,
          reason: "publish_failed",
        });
      } else if (plan.verdict.kind === "resume") {
        outcome.resumed.push(sessionName as string);
      } else {
        outcome.noticed.push(sessionName as string);
      }
    } catch (error) {
      outcome.skipped.push({
        sessionKey: attempt.sessionKey,
        attemptId: attempt.attemptId,
        reason: `error:${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  deps.completeRecoveryRun({
    recoveryRunId,
    summary: {
      restartEpoch: input.restartEpoch,
      resumed: outcome.resumed.length,
      noticed: outcome.noticed.length,
      skipped: outcome.skipped.length,
    },
  });
  return outcome;
}

function planRecovery(
  restartEpoch: string,
  attempt: RuntimeTurnAttemptRecord,
  sessionName: string | null,
  deps: Pick<OrphanedRestartTurnDeps, "hasDelivery" | "isTerminalTaskSession" | "hasLaterAttempt">,
): RecoveryPlan {
  if (deps.hasDelivery(restartEpoch, attempt.sessionKey)) {
    // The restart snapshot already resumed or notified this session.
    return { decision: "ignore_stale", reasonCode: "restart_event_delivered", action: "none" };
  }
  if (!sessionName) {
    return { decision: "ignore_stale", reasonCode: "session_missing", action: "none" };
  }
  if (deps.isTerminalTaskSession(sessionName, attempt.taskBarrierTaskId)) {
    return { decision: "ignore_stale", reasonCode: "terminal_task", action: "none" };
  }
  const verdict = judgeRestartInterruptedAttempt(attempt, deps);
  switch (verdict.kind) {
    case "resume":
      return { decision: "resume", reasonCode: "verify_continue", action: "publish_verify_continue", verdict };
    case "notice":
      return {
        decision: "reconcile_interrupted",
        reasonCode: verdict.fenceReason,
        action: "publish_restart_notice",
        verdict,
      };
    case "skip":
      return {
        decision:
          verdict.reason === "origin_scheduled"
            ? "defer_next_schedule"
            : verdict.reason === "origin_not_resumable"
              ? "reconcile_interrupted"
              : "ignore_stale",
        reasonCode: verdict.reason === "origin_not_resumable" ? `origin_${attempt.originKind}` : verdict.reason,
        action: "none",
      };
  }
}

function isLaterAttempt(candidate: RuntimeTurnAttemptRecord, current: RuntimeTurnAttemptRecord): boolean {
  return (
    candidate.startedAt > current.startedAt ||
    (candidate.startedAt === current.startedAt && candidate.attemptId > current.attemptId)
  );
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

type LedgerDeps = Pick<
  OrphanedRestartTurnDeps,
  | "now"
  | "listBootEpochs"
  | "abandonBootEpoch"
  | "listRunningAttempts"
  | "hasLaterAttempt"
  | "startRecoveryRun"
  | "recordCandidate"
  | "claimCandidate"
  | "completeClaim"
  | "completeRecoveryRun"
>;

/** The crash-recovery ledger side of the orphaned turn sweep, owned by `currentBootEpoch`. */
export function createLedgerOrphanedRestartTurnDeps(
  currentBootEpoch: string,
  options: { now?: () => number; runMetadata?: Record<string, unknown> } = {},
): LedgerDeps {
  const now = options.now ?? Date.now;
  return {
    now,
    listBootEpochs: () => [
      ...listRuntimeBootEpochs({ status: "active", limit: 200 }),
      ...listRuntimeBootEpochs({ status: "abandoned", limit: 200 }),
    ],
    abandonBootEpoch(boot, at) {
      try {
        markRuntimeBootEpochAbandoned({
          bootEpoch: boot.bootEpoch,
          abandonedAt: Math.max(at, boot.lastHeartbeatAt, boot.updatedAt),
          reason: "daemon_restart_orphaned",
          expectedLastHeartbeatAt: boot.lastHeartbeatAt,
          expectedLeaseExpiresAt: boot.leaseExpiresAt,
        });
        return true;
      } catch (error) {
        log.warn("Previous boot changed before it could be fenced; leaving its turns alone", {
          bootEpoch: boot.bootEpoch,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    },
    listRunningAttempts: (bootEpoch) => listRuntimeTurnAttempts({ bootEpoch, status: "running", limit: 1000 }),
    hasLaterAttempt: hasLaterRuntimeTurnAttempt,
    startRecoveryRun: () =>
      createRuntimeRecoveryRun({
        mode: "apply",
        bootEpoch: currentBootEpoch,
        startedAt: now(),
        metadata: { kind: "daemon_restart_orphaned_turns", ...(options.runMetadata ?? {}) },
      }),
    recordCandidate({ recoveryRunId, attempt, decision, reasonCode, action }) {
      recordRuntimeRecoveryCandidate({
        recoveryRunId,
        candidateType: "turn_attempt",
        sessionKey: attempt.sessionKey,
        sessionName: attempt.sessionName,
        attemptId: attempt.attemptId,
        turnId: attempt.turnId,
        decision,
        reasonCode,
        action,
        details: { bootEpoch: attempt.bootEpoch, originKind: attempt.originKind },
        recordedAt: now(),
      });
    },
    claimCandidate({ recoveryRunId, attempt }) {
      const { status, claim } = acquireRuntimeRecoveryClaim({
        recoveryRunId,
        candidateKey: buildRuntimeRecoveryCandidateKey({
          candidateType: "turn_attempt",
          sessionKey: attempt.sessionKey,
          attemptId: attempt.attemptId,
        }),
        claimedByBootEpoch: currentBootEpoch,
        claimedAt: now(),
      });
      return status === "acquired" ? { claimId: claim.claimId } : null;
    },
    completeClaim({ claimId, status, result }) {
      completeRuntimeRecoveryClaim({ claimId, status, result, completedAt: now() });
    },
    completeRecoveryRun({ recoveryRunId, summary }) {
      completeRuntimeRecoveryRun({ recoveryRunId, status: "complete", summary, completedAt: now() });
    },
  };
}
