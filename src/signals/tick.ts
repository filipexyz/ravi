import { dbGetSetting } from "../router/router-db.js";
import type {
  SignalOobSkipped,
  SignalRecord,
  SignalSeverity,
  SignalTickDependencies,
  SignalTickState,
  TickSignalsResult,
} from "./types.js";
import { effectiveSeverity, severityRank } from "./validation.js";
import {
  blockingPendingRoutes,
  dbAcquireTickLock,
  dbAppendSignalEvent,
  dbCountOobAttemptsInEpisode,
  dbGetKeyMute,
  dbGetLastOobAt,
  dbGetLastSurfaceAt,
  dbGetTickState,
  dbHasPendingSurface,
  dbIterateSignals,
  dbRecordTickRun,
  dbReleaseSignalSurface,
  dbReleaseTickLock,
  dbWriteSignalObservation,
  ensureSignalSchema,
  SIGNALS_TICK_INTERVAL_MS,
} from "./signal-db.js";
import { getDb } from "../router/router-db.js";
import { evaluateClearRule } from "./probes.js";
import { isSubjectTerminal, resolveSignalTargetSessions } from "./subjects.js";
import { deliverSignalOutboxRow, drainSignalOutbox, reserveSignalOob } from "./oob.js";
import { readSignalObservation } from "./observation.js";
import { closeSignal, oobEnabled, unmuteSignal } from "./service.js";
import { runDiskWatcher } from "./watch/disk.js";

const TICK_ACTOR = "signals.tick";
/** A piggyback reservation never confirmed by its turn (a crash between render and send) is released after this. */
const PIGGYBACK_RESERVATION_MAX_AGE_MS = 10 * 60_000;
const MAX_ESCALATIONS_PER_EPISODE = 3;

export function signalsEnabled(): boolean {
  return dbGetSetting("signals.enabled") === "true";
}

function recheckDue(signal: SignalRecord, now: number): boolean {
  if (signal.clearWhen.type === "decay" || signal.clearWhen.type === "manual") return true;
  if (!signal.lastEvalAt) return true;
  const recheck =
    signal.clearWhen.type === "probe"
      ? signal.clearWhen.recheck_ms
      : signal.clearWhen.type === "metric"
        ? signal.clearWhen.recheck_ms
        : 60_000;
  return now - signal.lastEvalAt >= recheck;
}

type EscalationDecision = { severity: SignalSeverity } | { skip: SignalOobSkipped["reason"] } | null;

/**
 * Whether a signal is due for OOB, and if so why it may still be held. `null`
 * means it is not an OOB candidate at all (piggyback-only, not old enough,
 * muted, inside the renotify window).
 */
function escalationDecision(signal: SignalRecord, now: number, tickState: SignalTickState): EscalationDecision {
  if (signal.kind !== "fact") return null;
  const effective = effectiveSeverity(signal.severity, signal.kind, signal.producerClass);
  if (effective === "ambient") return null;
  if (effective === "piggyback" && signal.escalateAfterMs === null) return null;
  const routeSeverity: SignalSeverity = effective === "piggyback" ? "nudge" : effective;
  if (signal.escalateAfterMs === null || signal.escalateAfterMs === undefined) return null;
  if (now - signal.openedAt < signal.escalateAfterMs) return null;
  if (signal.state === "muted") return null;
  if (dbGetKeyMute(signal.key, now)) return null;
  if (
    signal.state === "acknowledged" &&
    signal.acknowledgedAt &&
    now - signal.acknowledgedAt < signal.renotifyAfterMs
  ) {
    return null;
  }
  if (!oobEnabled()) return { skip: "oob_disabled" };
  // OOB requires a recent, successful evaluation (invariant 28).
  const observation = readSignalObservation(signal, tickState, now, { evaluatedAt: now });
  if (observation.status !== "fresh") return { skip: observation.status };
  // Cooldown is shared across routes; only `page` may follow a piggyback inside it.
  const lastSurface = routeSeverity === "page" ? dbGetLastOobAt(signal.id) : dbGetLastSurfaceAt(signal.id);
  if (lastSurface !== null && now - lastSurface < signal.cooldownMs) return { skip: "cooldown" };
  // Failed deliveries count toward the cap too, so an exhausted one is not
  // recreated under a fresh key forever.
  if (
    signal.escalationCount >= MAX_ESCALATIONS_PER_EPISODE ||
    dbCountOobAttemptsInEpisode(signal.id, signal.openedAt) >= MAX_ESCALATIONS_PER_EPISODE
  ) {
    return { skip: "escalation_cap" };
  }
  if (dbHasPendingSurface(signal.id, blockingPendingRoutes(routeSeverity === "page" ? "page" : "oob"))) {
    return { skip: "pending" };
  }
  return { severity: routeSeverity };
}

function releaseStalePiggybackReservations(now: number): number {
  const rows = getDb()
    .prepare(
      "SELECT id FROM signal_surfaces WHERE route = 'piggyback' AND status = 'pending' AND created_at < ? ORDER BY id",
    )
    .all(now - PIGGYBACK_RESERVATION_MAX_AGE_MS) as Array<{ id: number }>;
  let released = 0;
  for (const row of rows) {
    if (
      dbReleaseSignalSurface({
        surfaceId: row.id,
        reason: "turn never confirmed the reservation",
        actorId: TICK_ACTOR,
        now,
      })
    ) {
      released += 1;
    }
  }
  return released;
}

export async function tickSignals(deps: SignalTickDependencies = {}): Promise<TickSignalsResult> {
  const now = deps.now ?? Date.now();
  const execute = deps.execute === true;
  const tickIntervalMs = deps.tickIntervalMs ?? SIGNALS_TICK_INTERVAL_MS;
  const result: TickSignalsResult = {
    executed: false,
    evaluated: 0,
    resolved: 0,
    expired: 0,
    escalated: 0,
    errors: [],
    candidates: [],
    skipped: [],
    outbox: { sent: 0, retried: 0, failed: 0 },
    watchers: [],
    tickState: { ...dbGetTickStateSafe(), tickIntervalMs },
  };

  if (!signalsEnabled()) {
    return result;
  }
  ensureSignalSchema();

  const holder = `tick:${process.pid}:${now}`;
  if (execute && !dbAcquireTickLock(holder, now)) {
    return result;
  }

  try {
    const tickState = dbGetTickState();
    const delivery = {
      ...(deps.publishPrompt ? { publishPrompt: deps.publishPrompt } : {}),
      ...(deps.sendPage ? { sendPage: deps.sendPage } : {}),
    };
    if (deps.runWatchers !== false) {
      const watcher = runDiskWatcher({
        now,
        execute,
        ...(deps.probe ? { probe: (probeId: string) => deps.probe!(probeId) } : {}),
      });
      result.watchers.push(watcher);
      if (watcher.error) {
        result.errors.push({ id: watcher.id, error: watcher.error });
      }
    }

    if (execute) releaseStalePiggybackReservations(now);

    for (const listed of dbIterateSignals({ state: "non_terminal" })) {
      let signal = listed;
      if (isSubjectTerminal(signal.subjectType, signal.subjectId, now)) {
        if (execute) {
          closeSignal(
            signal.id,
            {
              state: "resolved",
              closeReason: "subject_terminal",
              message: "terminal subject guard",
              actorId: TICK_ACTOR,
            },
            now,
          );
          result.resolved += 1;
        }
        continue;
      }

      if (signal.state === "muted" && signal.mutedUntil && signal.mutedUntil <= now && execute) {
        signal = unmuteSignal({ idOrKey: signal.id, expired: true, now });
      }

      if (recheckDue(signal, now)) {
        result.evaluated += 1;
        const evaluation = evaluateClearRule(signal, { now, probe: deps.probe });
        if (execute) {
          // The cache render reads: the evaluation's own time and its real error.
          dbWriteSignalObservation(
            {
              signalId: signal.id,
              observedAt: now,
              error: evaluation.error ?? null,
              fields: evaluation.fields,
              clearSince: evaluation.nextClearSince,
            },
            now,
          );
          signal = { ...signal, lastEvalAt: now, lastEvalError: evaluation.error ?? null };
          if (evaluation.error) {
            dbAppendSignalEvent({
              signalId: signal.id,
              type: "signal.eval_failed",
              actorType: "system",
              actorId: TICK_ACTOR,
              message: evaluation.error,
              now,
            });
          }
          // A failed evaluation never resolves (invariant 15).
          if (evaluation.cleared && !evaluation.error) {
            const closeReason = signal.clearWhen.type === "probe" ? "probe" : signal.clearWhen.type;
            closeSignal(
              signal.id,
              { state: "resolved", closeReason, message: "clear rule matched", actorId: TICK_ACTOR },
              now,
            );
            result.resolved += 1;
            continue;
          }
        }
      }

      if (now - signal.lastSeenAt >= signal.ttlMs) {
        if (execute) {
          closeSignal(
            signal.id,
            { state: "expired", closeReason: "ttl", message: "ttl elapsed without observation", actorId: TICK_ACTOR },
            now,
          );
          result.expired += 1;
          continue;
        }
      }

      if (signal.surfaceCount >= signal.maxSurfaces) {
        if (execute) {
          closeSignal(
            signal.id,
            {
              state: "expired",
              closeReason: "ignored",
              message: "surface limit reached without ack",
              actorId: TICK_ACTOR,
            },
            now,
          );
          result.expired += 1;
        }
      }
    }

    // Retries go through the outbox and nowhere else; a signal whose row was
    // retried or failed in this tick is not reserved again in the same tick.
    const drained = new Set<string>();
    if (execute) {
      for (const outcome of await drainSignalOutbox({ tickState, now, evaluatedAt: now, ...delivery })) {
        if (outcome.signalId) drained.add(outcome.signalId);
        if (outcome.outcome === "sent") {
          result.outbox.sent += 1;
          result.escalated += 1;
        } else if (outcome.outcome === "retry") result.outbox.retried += 1;
        else if (outcome.outcome === "failed") result.outbox.failed += 1;
      }
    }

    const bySession = new Map<string, { signal: SignalRecord; severity: SignalSeverity }>();
    for (const signal of dbIterateSignals({ state: "non_terminal" })) {
      const decision = drained.has(signal.id)
        ? ({ skip: "pending" } as const)
        : escalationDecision(signal, now, tickState);
      if (!decision) continue;
      const sessions = resolveSignalTargetSessions(signal);
      if ("skip" in decision) {
        for (const sessionName of sessions) result.skipped.push({ id: signal.id, sessionName, reason: decision.skip });
        continue;
      }
      for (const sessionName of sessions) {
        const current = bySession.get(sessionName);
        if (
          !current ||
          severityRank(decision.severity) > severityRank(current.severity) ||
          (severityRank(decision.severity) === severityRank(current.severity) &&
            signal.openedAt < current.signal.openedAt)
        ) {
          bySession.set(sessionName, { signal, severity: decision.severity });
        }
      }
    }

    for (const [sessionName, candidate] of bySession) {
      result.candidates.push({
        id: candidate.signal.id,
        route: candidate.severity === "page" ? "page" : "oob",
        severity: candidate.severity,
        sessionName,
      });
      if (!execute) continue;
      try {
        const reservation = reserveSignalOob({
          signal: candidate.signal,
          sessionName,
          routeSeverity: candidate.severity,
          freshEvaluation: true,
          now,
        });
        if (!reservation.reserved) {
          result.skipped.push({ id: candidate.signal.id, sessionName, reason: reservation.reason });
          continue;
        }
        const delivered = await deliverSignalOutboxRow({
          outboxId: reservation.outboxId,
          tickState,
          now,
          evaluatedAt: now,
          ...delivery,
        });
        if (delivered.outcome === "sent") {
          result.escalated += 1;
          result.outbox.sent += 1;
        } else if (delivered.outcome === "retry") result.outbox.retried += 1;
        else if (delivered.outcome === "failed") result.outbox.failed += 1;
      } catch (error) {
        result.errors.push({
          id: candidate.signal.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    result.executed = execute;
    if (execute) {
      // Only a tick that completed without error advances the freshness anchor.
      result.tickState = dbRecordTickRun({
        now,
        tickIntervalMs,
        error: result.errors.length > 0 ? result.errors.map((item) => `${item.id}: ${item.error}`).join("; ") : null,
      });
    }
    return result;
  } catch (error) {
    if (execute) {
      dbRecordTickRun({ now, tickIntervalMs, error: error instanceof Error ? error.message : String(error) });
    }
    throw error;
  } finally {
    if (execute) dbReleaseTickLock(holder);
  }
}

function dbGetTickStateSafe(): SignalTickState {
  try {
    return dbGetTickState();
  } catch {
    return {
      lastSuccessfulTickAt: null,
      lastTickAt: null,
      lastTickError: null,
      tickIntervalMs: SIGNALS_TICK_INTERVAL_MS,
      staleAfterMs: 2 * SIGNALS_TICK_INTERVAL_MS,
      staleAfterSource: "default",
    };
  }
}
