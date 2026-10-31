import { dbGetSetting } from "../router/router-db.js";
import type { SignalRecord, SignalSeverity, SignalTickDependencies, TickSignalsResult } from "./types.js";
import { effectiveSeverity, severityRank } from "./validation.js";
import {
  dbAcquireTickLock,
  dbAppendSignalEvent,
  dbGetKeyMute,
  dbGetLastOobAt,
  dbListNonTerminalSignals,
  dbReleaseTickLock,
  dbUpdateSignal,
} from "./signal-db.js";
import { evaluateClearRule } from "./probes.js";
import { isSubjectTerminal, resolveSignalTargetSessions } from "./subjects.js";
import { deliverSignalOob } from "./oob.js";
import { runDiskWatcher } from "./watch/disk.js";

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

function resolveSignalRecord(signal: SignalRecord, closeReason: string, message: string, now: number): void {
  signal.state = "resolved";
  signal.closedAt = now;
  signal.closeReason = closeReason;
  signal.version += 1;
  signal.updatedAt = now;
  dbUpdateSignal(signal);
  dbAppendSignalEvent({
    signalId: signal.id,
    type: "signal.resolved",
    actorType: "system",
    actorId: "signals.tick",
    message,
    now,
  });
}

function expireSignalRecord(signal: SignalRecord, closeReason: string, message: string, now: number): void {
  signal.state = "expired";
  signal.closedAt = now;
  signal.closeReason = closeReason;
  signal.version += 1;
  signal.updatedAt = now;
  dbUpdateSignal(signal);
  dbAppendSignalEvent({
    signalId: signal.id,
    type: "signal.expired",
    actorType: "system",
    actorId: "signals.tick",
    message,
    now,
  });
}

function escalationEligible(signal: SignalRecord, now: number): SignalSeverity | null {
  const effective = effectiveSeverity(signal.severity, signal.kind, signal.producerClass);
  if (effective === "ambient") return null;
  if (effective === "piggyback" && signal.kind !== "fact") return null;
  if (effective === "piggyback" && signal.escalateAfterMs === null) return null;
  const routeSeverity: SignalSeverity = effective === "piggyback" ? "nudge" : effective;
  if (routeSeverity !== "nudge" && routeSeverity !== "interrupt" && routeSeverity !== "page") return null;
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
  const lastOob = dbGetLastOobAt(signal.id);
  if (lastOob && now - lastOob < signal.cooldownMs) return null;
  if (signal.escalationCount >= 3) return null;
  return routeSeverity;
}

export async function tickSignals(deps: SignalTickDependencies = {}): Promise<TickSignalsResult> {
  const now = deps.now ?? Date.now();
  const execute = deps.execute === true;
  const result: TickSignalsResult = {
    executed: false,
    evaluated: 0,
    resolved: 0,
    expired: 0,
    escalated: 0,
    errors: [],
    candidates: [],
    watchers: [],
  };

  if (!signalsEnabled()) {
    return result;
  }

  const holder = `tick:${process.pid}:${now}`;
  if (execute && !dbAcquireTickLock(holder, now)) {
    return result;
  }

  try {
    if (deps.runWatchers !== false) {
      // One watcher failing must not stop the sweep: the clear, TTL and
      // out-of-band delivery passes below still run.
      try {
        const watcher = runDiskWatcher({
          now,
          execute,
          ...(deps.probe ? { probe: (probeId: string) => deps.probe!(probeId) } : {}),
        });
        result.watchers.push(watcher);
        if (watcher.error) {
          result.errors.push({ id: watcher.id, error: watcher.error });
        }
      } catch (error) {
        result.errors.push({
          id: "signals.watch.disk",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    let signals = dbListNonTerminalSignals();
    for (const signal of signals) {
      if (isSubjectTerminal(signal.subjectType, signal.subjectId, now)) {
        if (execute) {
          resolveSignalRecord(signal, "subject_terminal", "terminal subject guard", now);
          result.resolved += 1;
        }
        continue;
      }

      if (signal.state === "muted" && signal.mutedUntil && signal.mutedUntil <= now) {
        if (execute) {
          signal.state = signal.previousState ?? "open";
          signal.previousState = undefined;
          signal.mutedUntil = null;
          signal.version += 1;
          signal.updatedAt = now;
          dbUpdateSignal(signal);
        }
      }

      if (recheckDue(signal, now)) {
        result.evaluated += 1;
        const evaluation = evaluateClearRule(signal, { now, probe: deps.probe });
        if (execute) {
          signal.lastEvalAt = now;
          signal.lastEvalError = evaluation.error ?? null;
          signal.clearSince = evaluation.nextClearSince;
          if (evaluation.error) {
            dbAppendSignalEvent({
              signalId: signal.id,
              type: "signal.eval_failed",
              actorType: "system",
              message: evaluation.error,
              now,
            });
          }
          if (evaluation.cleared) {
            resolveSignalRecord(
              signal,
              signal.clearWhen.type === "decay" ? "decay" : "probe",
              "clear rule matched",
              now,
            );
            result.resolved += 1;
            continue;
          }
          dbUpdateSignal(signal);
        }
      }

      if (now - signal.lastSeenAt >= signal.ttlMs) {
        if (execute) {
          expireSignalRecord(signal, "ttl", "ttl elapsed without observation", now);
          result.expired += 1;
          continue;
        }
      }

      if (signal.surfaceCount >= signal.maxSurfaces) {
        if (execute) {
          expireSignalRecord(signal, "ignored", "surface limit reached without ack", now);
          result.expired += 1;
        }
      }
    }

    signals = dbListNonTerminalSignals();
    const bySession = new Map<string, { signal: SignalRecord; severity: SignalSeverity }>();
    for (const signal of signals) {
      const severity = escalationEligible(signal, now);
      if (!severity) continue;
      for (const sessionName of resolveSignalTargetSessions(signal)) {
        const current = bySession.get(sessionName);
        if (
          !current ||
          severityRank(severity) > severityRank(current.severity) ||
          (severityRank(severity) === severityRank(current.severity) && signal.openedAt < current.signal.openedAt)
        ) {
          bySession.set(sessionName, { signal, severity });
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
        const delivered = await deliverSignalOob({
          signal: candidate.signal,
          sessionName,
          now,
          routeSeverity: candidate.severity,
          ...(deps.publishPrompt ? { publishPrompt: deps.publishPrompt } : {}),
          ...(deps.sendPage ? { sendPage: deps.sendPage } : {}),
        });
        if (delivered.delivered) result.escalated += 1;
      } catch (error) {
        result.errors.push({
          id: candidate.signal.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    result.executed = execute;
    return result;
  } finally {
    if (execute) dbReleaseTickLock(holder);
  }
}
