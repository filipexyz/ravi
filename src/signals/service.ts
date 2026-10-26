import { randomUUID } from "node:crypto";
import { dbGetSetting } from "../router/router-db.js";
import type {
  ListSignalsOptions,
  RaiseSignalInput,
  RaiseSignalResult,
  SignalBudget,
  SignalRecord,
  SignalSeverity,
} from "./types.js";
import {
  assertSignalTitle,
  effectiveSeverity,
  kindCeiling,
  minSeverity,
  normalizeProducerClass,
  normalizeSeverity,
  producerClassCeiling,
  sanitizeSignalText,
  severityRank,
  validateClearWhen,
} from "./validation.js";
import {
  budgetDay,
  dbAppendSignalEvent,
  dbCountBudgetSurfaces,
  dbGetKeyMute,
  dbGetLastOobAt,
  dbGetLastSurfaceAt,
  dbGetLatestSignalByKey,
  dbGetNonTerminalSignalByKey,
  dbGetSignalById,
  dbInsertSignal,
  dbListSignalEvents,
  dbListSignals,
  dbUpdateSignal,
  ensureSignalSchema,
} from "./signal-db.js";
import { isSubjectTerminal, resolveSignalTargetSessions } from "./subjects.js";
import { describeClearRule, evaluateClearRule, isProbeRegistered } from "./probes.js";

const DEFAULT_COOLDOWN_MS: Record<SignalSeverity, number> = {
  ambient: 24 * 3_600_000,
  piggyback: 6 * 3_600_000,
  nudge: 6 * 3_600_000,
  interrupt: 6 * 3_600_000,
  page: 6 * 3_600_000,
};

const DEFAULT_RENOTIFY_MS: Record<SignalSeverity, number> = {
  ambient: 24 * 3_600_000,
  piggyback: 24 * 3_600_000,
  nudge: 12 * 3_600_000,
  interrupt: 4 * 3_600_000,
  page: 60 * 60_000,
};

const DEFAULT_ESCALATE_MS: Record<SignalSeverity, number | null> = {
  ambient: null,
  piggyback: null,
  nudge: 60 * 60_000,
  interrupt: 15 * 60_000,
  page: 0,
};

function defaultRenotify(severity: SignalSeverity): number {
  return DEFAULT_RENOTIFY_MS[severity];
}

function defaultCooldown(severity: SignalSeverity): number {
  return DEFAULT_COOLDOWN_MS[severity];
}

export function raiseSignal(input: RaiseSignalInput): RaiseSignalResult {
  ensureSignalSchema();
  const now = input.now ?? Date.now();
  const title = assertSignalTitle(input.title);
  const severity = normalizeSeverity(input.severity);
  const clearWhen = validateClearWhen(input.clearWhen, input.kind);
  if (clearWhen.type === "probe" && !isProbeRegistered(clearWhen.probe)) {
    throw new Error(`Unknown probe: ${clearWhen.probe}`);
  }
  const producerClass = normalizeProducerClass(input.producerClass, input.kind, input.producerId);
  const producerType = input.producerType ?? (input.kind === "fact" ? "code" : "agent");

  if (input.kind === "fact" && producerType !== "code") {
    throw new Error("Facts must be raised by code producers.");
  }
  if (input.kind === "judgment" && producerType === "code") {
    throw new Error("Judgments must be raised by agents or observers.");
  }
  if (input.kind === "judgment" && producerClass === "code") {
    throw new Error("A judgment cannot use the code producer class.");
  }

  const effective = effectiveSeverity(severity, input.kind, producerClass);
  if (severityRank(severity) > severityRank(kindCeiling(input.kind))) {
    throw new Error(
      `A ${input.kind} cannot use severity ${severity}; effective ceiling is ${kindCeiling(input.kind)}.`,
    );
  }
  if (severityRank(severity) > severityRank(producerClassCeiling(producerClass))) {
    throw new Error(
      `Producer class ${producerClass} cannot use severity ${severity}; effective ceiling is ${producerClassCeiling(producerClass)}.`,
    );
  }
  if (input.kind === "judgment" && (input.escalateAfterMs ?? 0) > 0) {
    throw new Error("A judgment cannot escalate out of band.");
  }
  if (isSubjectTerminal(input.subjectType, input.subjectId, now)) {
    throw new Error("ENTITY_TERMINAL: the signal subject is terminal or archived.");
  }

  const existing = dbGetNonTerminalSignalByKey(input.key);
  if (existing) {
    // Another owner's or kind's open key is not ours to rewrite.
    if (existing.kind !== input.kind || existing.producerType !== producerType) {
      throw new Error(
        `Key ${input.key} belongs to a ${existing.kind} raised by ${existing.producerType}; cross-owner or cross-kind raise is not allowed.`,
      );
    }
    let changed = false;
    if (title !== existing.title) {
      existing.title = title;
      changed = true;
    }
    const detail = input.detail ? sanitizeSignalText(input.detail, 500) : existing.detail;
    if (detail !== existing.detail) {
      existing.detail = detail;
      changed = true;
    }
    if (JSON.stringify(input.evidence ?? existing.evidence) !== JSON.stringify(existing.evidence)) {
      existing.evidence = input.evidence ?? existing.evidence;
      changed = true;
    }
    if (JSON.stringify(clearWhen) !== JSON.stringify(existing.clearWhen)) {
      existing.clearWhen = clearWhen;
      existing.clearSince = null;
      changed = true;
    }
    if (effective !== existing.severity) {
      existing.severity = effective;
      changed = true;
      dbAppendSignalEvent({
        signalId: existing.id,
        type: "signal.ceiling_clamped",
        actorType: "system",
        message: `stored severity clamped to ${effective} for producer class ${producerClass}`,
        now,
      });
    }
    existing.lastSeenAt = now;
    existing.targetSessions = input.targetSessions ?? existing.targetSessions;
    existing.subjectType = input.subjectType ?? existing.subjectType;
    existing.subjectId = input.subjectId ?? existing.subjectId;
    existing.dedupeKey = input.dedupeKey ?? existing.dedupeKey;
    existing.updatedAt = now;
    if (changed) existing.version += 1;
    dbUpdateSignal(existing);
    dbAppendSignalEvent({
      signalId: existing.id,
      type: changed ? "signal.updated" : "signal.refreshed",
      actorType: producerType,
      actorId: input.producerId,
      payload: { kind: input.kind, severity: existing.severity, clearWhen: existing.clearWhen },
      now,
    });
    return { signal: existing, created: false, updated: changed };
  }

  const latest = dbGetLatestSignalByKey(input.key);
  const reopenAfter = input.reopenAfterMs ?? 24 * 3_600_000;
  if (latest?.closedAt && now - latest.closedAt < reopenAfter) {
    return { signal: latest, created: false, updated: false, suppressed: "reopen" };
  }

  const signal: SignalRecord = {
    id: `sig_${randomUUID().replaceAll("-", "")}`,
    key: input.key,
    schemaVersion: 1,
    kind: input.kind,
    producerType,
    producerClass,
    producerId: input.producerId,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    targetSessions: input.targetSessions,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    severity: effective,
    title,
    detail: input.detail ? sanitizeSignalText(input.detail, 500) : undefined,
    evidence: input.evidence,
    clearWhen,
    state: "open",
    dedupeKey: input.dedupeKey,
    cooldownMs: input.cooldownMs ?? defaultCooldown(effective),
    renotifyAfterMs: input.renotifyAfterMs ?? defaultRenotify(effective),
    escalateAfterMs: input.escalateAfterMs === undefined ? DEFAULT_ESCALATE_MS[effective] : input.escalateAfterMs,
    maxSurfaces: input.maxSurfaces ?? 3,
    ttlMs: input.ttlMs ?? 24 * 3_600_000,
    reopenAfterMs: reopenAfter,
    mutedUntil: null,
    surfaceCount: 0,
    escalationCount: 0,
    openedAt: now,
    lastSeenAt: now,
    lastEvalAt: null,
    lastEvalError: null,
    clearSince: null,
    surfacedAt: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    closedAt: null,
    closeReason: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  dbInsertSignal(signal);
  dbAppendSignalEvent({
    signalId: signal.id,
    type: "signal.raised",
    actorType: producerType,
    actorId: input.producerId,
    payload: {
      key: signal.key,
      kind: signal.kind,
      severity: signal.severity,
      scope: `${signal.scopeType}:${signal.scopeId}`,
      clearWhen: signal.clearWhen,
    },
    now,
  });
  return { signal, created: true, updated: false };
}

export function findSignal(idOrKey: string): SignalRecord | null {
  ensureSignalSchema();
  return dbGetSignalById(idOrKey) ?? dbGetNonTerminalSignalByKey(idOrKey) ?? dbGetLatestSignalByKey(idOrKey);
}

export function updateSignal(input: {
  idOrKey: string;
  severity?: SignalSeverity;
  title?: string;
  detail?: string;
  evidence?: Record<string, unknown>;
  by?: string;
  now?: number;
}): SignalRecord {
  const now = input.now ?? Date.now();
  const signal = findSignal(input.idOrKey);
  if (!signal) throw new Error(`Signal not found: ${input.idOrKey}`);
  if (signal.state === "resolved" || signal.state === "expired") {
    throw new Error("Cannot update a terminal signal.");
  }
  if (input.severity) {
    const effective = effectiveSeverity(input.severity, signal.kind, signal.producerClass);
    if (severityRank(input.severity) > severityRank(effective)) {
      throw new Error(`Severity ${input.severity} exceeds the producer ceiling (${effective}).`);
    }
    signal.severity = effective;
  }
  if (input.title) signal.title = assertSignalTitle(input.title);
  if (input.detail !== undefined) signal.detail = sanitizeSignalText(input.detail, 500);
  if (input.evidence) signal.evidence = input.evidence;
  signal.version += 1;
  signal.updatedAt = now;
  dbUpdateSignal(signal);
  dbAppendSignalEvent({
    signalId: signal.id,
    type: "signal.updated",
    actorType: input.by?.startsWith("agent:") ? "agent" : "operator",
    actorId: input.by ?? "operator",
    now,
  });
  return signal;
}

export function ackSignal(input: { idOrKey: string; by?: string; note?: string; now?: number }): SignalRecord {
  const now = input.now ?? Date.now();
  const signal = findSignal(input.idOrKey);
  if (!signal) throw new Error(`Signal not found: ${input.idOrKey}`);
  if (signal.state === "resolved" || signal.state === "expired") return signal;
  if (signal.state === "muted") {
    signal.acknowledgedAt = now;
    signal.acknowledgedBy = input.by ?? "operator";
    signal.version += 1;
    signal.updatedAt = now;
    dbUpdateSignal(signal);
    dbAppendSignalEvent({
      signalId: signal.id,
      type: "signal.acknowledged",
      actorType: input.by?.startsWith("agent:") ? "agent" : "operator",
      actorId: input.by ?? "operator",
      message: input.note ? sanitizeSignalText(input.note, 500) : undefined,
      payload: { muted: true },
      now,
    });
    return signal;
  }
  signal.state = "acknowledged";
  signal.acknowledgedAt = now;
  signal.acknowledgedBy = input.by ?? "operator";
  signal.surfacedAt = signal.surfacedAt ?? now;
  signal.version += 1;
  signal.updatedAt = now;
  dbUpdateSignal(signal);
  dbAppendSignalEvent({
    signalId: signal.id,
    type: "signal.acknowledged",
    actorType: input.by?.startsWith("agent:") ? "agent" : "operator",
    actorId: input.by ?? "operator",
    message: input.note ? sanitizeSignalText(input.note, 500) : undefined,
    now,
  });
  return signal;
}

export function resolveSignal(input: {
  idOrKey: string;
  reason: string;
  by?: string;
  closeReason?: string;
  now?: number;
}): SignalRecord {
  const reason = input.reason?.trim();
  if (!reason) throw new Error("--reason is required to resolve a signal.");
  const now = input.now ?? Date.now();
  const signal = findSignal(input.idOrKey);
  if (!signal) throw new Error(`Signal not found: ${input.idOrKey}`);
  if (signal.state === "resolved" || signal.state === "expired") return signal;
  signal.state = "resolved";
  signal.closedAt = now;
  signal.closeReason = input.closeReason ?? (input.by ? "operator" : "operator");
  signal.version += 1;
  signal.updatedAt = now;
  dbUpdateSignal(signal);
  dbAppendSignalEvent({
    signalId: signal.id,
    type: "signal.resolved",
    actorType: input.by?.startsWith("agent:") ? "agent" : "operator",
    actorId: input.by ?? "operator",
    message: sanitizeSignalText(reason, 500),
    now,
  });
  return signal;
}

export function muteSignal(input: {
  idOrKey: string;
  forMs: number;
  reason?: string;
  by?: string;
  now?: number;
}): SignalRecord {
  const now = input.now ?? Date.now();
  const signal = findSignal(input.idOrKey);
  if (!signal) throw new Error(`Signal not found: ${input.idOrKey}`);
  if (signal.state === "resolved" || signal.state === "expired") {
    throw new Error("Cannot mute a terminal signal.");
  }
  const previous = signal.state === "muted" ? signal.previousState : signal.state;
  signal.state = "muted";
  signal.previousState =
    previous === "open" || previous === "surfaced" || previous === "acknowledged" ? previous : "open";
  signal.mutedUntil = now + input.forMs;
  signal.muteReason = input.reason ? sanitizeSignalText(input.reason, 500) : undefined;
  signal.version += 1;
  signal.updatedAt = now;
  dbUpdateSignal(signal);
  dbAppendSignalEvent({
    signalId: signal.id,
    type: "signal.muted",
    actorType: input.by?.startsWith("agent:") ? "agent" : "operator",
    actorId: input.by ?? "operator",
    message: signal.muteReason,
    payload: { mutedUntil: signal.mutedUntil },
    now,
  });
  return signal;
}

export function unmuteSignal(input: { idOrKey: string; by?: string; now?: number }): SignalRecord {
  const now = input.now ?? Date.now();
  const signal = findSignal(input.idOrKey);
  if (!signal) throw new Error(`Signal not found: ${input.idOrKey}`);
  if (signal.state !== "muted") return signal;
  signal.state = signal.previousState ?? "open";
  signal.previousState = undefined;
  signal.mutedUntil = null;
  signal.muteReason = undefined;
  signal.version += 1;
  signal.updatedAt = now;
  dbUpdateSignal(signal);
  dbAppendSignalEvent({
    signalId: signal.id,
    type: "signal.unmuted",
    actorType: input.by?.startsWith("agent:") ? "agent" : "operator",
    actorId: input.by ?? "operator",
    now,
  });
  return signal;
}

export function listSignals(options: ListSignalsOptions = {}): SignalRecord[] {
  return dbListSignals(options);
}

export function getSignalBudget(now = Date.now(), sessionName?: string): SignalBudget {
  ensureSignalSchema();
  const day = budgetDay(now);
  const limitSetting = Number(
    dbGetSetting("signals.surface_budget_per_day") ?? process.env.RAVI_SIGNALS_SURFACE_BUDGET ?? "3",
  );
  const limit = Number.isFinite(limitSetting) && limitSetting > 0 ? Math.floor(limitSetting) : 3;
  const used = dbCountBudgetSurfaces(day, sessionName);
  return { day, used, limit, held: Math.max(0, used - limit) };
}

export interface SignalExplanation {
  signal: SignalRecord;
  effectiveSeverity: SignalSeverity;
  targetSessions: string[];
  clearRule: string;
  lastEvaluation: {
    at: number | null;
    error: string | null;
    cleared: boolean | null;
    fields?: Record<string, unknown>;
  };
  budget: SignalBudget;
  lastSurfaceAt: number | null;
  lastOobAt: number | null;
  keyMute: { mutedUntil: number; reason?: string } | null;
  events: ReturnType<typeof dbListSignalEvents>;
}

export function explainSignal(idOrKey: string, now = Date.now()): SignalExplanation | null {
  const signal = findSignal(idOrKey);
  if (!signal) return null;
  const evaluation = evaluateClearRule(signal, { now });
  return {
    signal,
    effectiveSeverity: effectiveSeverity(signal.severity, signal.kind, signal.producerClass),
    targetSessions: resolveSignalTargetSessions(signal),
    clearRule: describeClearRule(signal.clearWhen),
    lastEvaluation: {
      at: signal.lastEvalAt ?? null,
      error: signal.lastEvalError ?? null,
      cleared: evaluation.error ? null : evaluation.cleared,
      fields: evaluation.fields,
    },
    budget: getSignalBudget(now),
    lastSurfaceAt: dbGetLastSurfaceAt(signal.id),
    lastOobAt: dbGetLastOobAt(signal.id),
    keyMute: dbGetKeyMute(signal.key, now),
    events: dbListSignalEvents(signal.id),
  };
}

export function clampStoredSeverity(signal: SignalRecord): { signal: SignalRecord; clamped: boolean } {
  const effective = effectiveSeverity(signal.severity, signal.kind, signal.producerClass);
  if (effective === signal.severity) return { signal, clamped: false };
  const next = { ...signal, severity: minSeverity(signal.severity, effective) };
  return { signal: next, clamped: true };
}
