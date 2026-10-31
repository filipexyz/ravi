import { randomUUID } from "node:crypto";
import { dbGetSetting } from "../router/router-db.js";
import type {
  ClearWhen,
  ListSignalsOptions,
  RaiseSignalInput,
  RaiseSignalResult,
  SignalBudget,
  SignalCaller,
  SignalObservationStatus,
  SignalRecord,
  SignalSeverity,
} from "./types.js";
import {
  assertSignalTitle,
  effectiveSeverity,
  evaluateClearExpression,
  kindCeiling,
  minSeverity,
  normalizeProducerClass,
  normalizeSeverity,
  producerClassCeiling,
  sanitizeSignalText,
  severityRank,
  SignalNotFoundError,
  SignalUsageError,
  validateClearWhen,
} from "./validation.js";
import {
  budgetDay,
  dbClearSignalObservation,
  dbCommitSignalTransition,
  dbCountBudgetUnits,
  dbCountOobSlots,
  dbCountSignalSurfaces,
  dbGetKeyMute,
  dbGetLastOobAt,
  dbGetLastSurfaceAt,
  dbGetLatestSignalByKey,
  dbGetNonTerminalSignalByKey,
  dbGetSignalById,
  dbGetTickState,
  dbInsertRaisedSignal,
  dbIterateSignals,
  dbListSignalEvents,
  dbListSignals,
  ensureSignalSchema,
  type SignalAudit,
} from "./signal-db.js";
import {
  isSubjectTerminal,
  readSessionSignalContext,
  resolveSignalTargetSessions,
  signalIsInSessionScope,
} from "./subjects.js";
import { describeClearRule, validateClearRuleFields } from "./probes.js";
import { readSignalObservation } from "./observation.js";

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

const DEFAULT_REOPEN_AFTER_MS = 24 * 3_600_000;
const TRANSITION_ATTEMPTS = 3;

function isTerminal(signal: Pick<SignalRecord, "state">): boolean {
  return signal.state === "resolved" || signal.state === "expired";
}

/** The owner an agent caller raises under: its agent id, never a value from the request. */
export function callerOwnerId(caller: SignalCaller | undefined): string | null {
  if (!caller?.isAgent) return null;
  const agentId = caller.agentId?.trim();
  return agentId ? `agent:${agentId}` : null;
}

function actorFor(caller: SignalCaller | undefined, by: string | undefined): { actorType: string; actorId: string } {
  if (caller?.isAgent) {
    return { actorType: "agent", actorId: callerOwnerId(caller) ?? `session:${caller.sessionName ?? "unknown"}` };
  }
  return { actorType: "operator", actorId: by?.trim() || "operator" };
}

/**
 * Apply one named transition with compare-and-swap on `version`. `apply`
 * receives a fresh copy of the record and either mutates it or returns
 * `"noop"`; it runs again on every retry, so eligibility is re-validated after
 * any concurrent change (invariant 21).
 */
export function transitionSignal(
  id: string,
  apply: (draft: SignalRecord) => "noop" | void,
  audit: SignalAudit | ((draft: SignalRecord) => SignalAudit),
  now = Date.now(),
): { signal: SignalRecord; changed: boolean } {
  for (let attempt = 0; attempt < TRANSITION_ATTEMPTS; attempt += 1) {
    const current = dbGetSignalById(id);
    if (!current) throw new SignalNotFoundError(id);
    const draft: SignalRecord = { ...current };
    if (apply(draft) === "noop") return { signal: current, changed: false };
    const entry = typeof audit === "function" ? audit(draft) : audit;
    if (dbCommitSignalTransition(current, draft, entry, now)) {
      return { signal: dbGetSignalById(id) ?? draft, changed: true };
    }
  }
  throw new Error(`Signal ${id} kept changing while a transition was applied; retry.`);
}

/** The caller's session as scope sees it, with the agent named by the context itself. */
function callerSessionContext(caller: SignalCaller, sessionName: string) {
  const context = readSessionSignalContext(sessionName);
  return caller.agentId?.trim() ? { ...context, agentId: caller.agentId.trim() } : context;
}

function assertScopeIncludesCaller(
  caller: SignalCaller,
  scope: Pick<SignalRecord, "scopeType" | "scopeId" | "targetSessions">,
): void {
  const sessionName = caller.sessionName?.trim();
  if (!sessionName) {
    throw new SignalUsageError("An agent turn without a session cannot raise signals.");
  }
  if (scope.targetSessions?.some((name) => name !== sessionName)) {
    throw new SignalUsageError("An agent may target only its own session.");
  }
  const probe = { ...scope, targetSessions: undefined } as SignalRecord;
  if (!signalIsInSessionScope(probe, callerSessionContext(caller, sessionName))) {
    throw new SignalUsageError(
      `Scope ${scope.scopeType}:${scope.scopeId} does not include this session; an agent raises only into its own scope.`,
    );
  }
}

/** Key namespaces owned by Ravi's own producers (watchers and task producers). */
const PRODUCER_OWNED_KEY_PREFIXES = ["host.", "task.stalled.", "task.orphaned."];

/**
 * An agent turn may not raise on a key Ravi's producers own: its judgment would
 * hold the key, and the cross-kind guard would then block the producer's fact.
 */
export function isProducerOwnedSignalKey(key: string): boolean {
  return PRODUCER_OWNED_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function raiseSignal(input: RaiseSignalInput): RaiseSignalResult {
  ensureSignalSchema();
  const now = input.now ?? Date.now();
  const caller = input.caller;
  const title = assertSignalTitle(input.title);
  const severity = normalizeSeverity(input.severity);
  const clearWhen = validateClearWhen(input.clearWhen, input.kind);
  validateClearRuleFields(clearWhen, input.evidence);

  // Authority comes from the resolved invocation context, never from the kind
  // or producer named in the request (invariants 5 and 7).
  let producerId = input.producerId;
  let producerType = input.producerType ?? (input.kind === "fact" ? "code" : "agent");
  if (caller?.isAgent) {
    if (input.kind === "fact") {
      throw new SignalUsageError(
        "Facts must be raised by code producers. Agent turns may raise judgment signals only.",
      );
    }
    const owner = callerOwnerId(caller);
    if (!owner) throw new SignalUsageError("The agent context does not name an agent.");
    producerId = owner;
    producerType = "agent";
    assertScopeIncludesCaller(caller, input);
  }
  const producerClass = normalizeProducerClass(input.producerClass, input.kind, producerId);

  if (input.kind === "fact" && producerType !== "code") {
    throw new SignalUsageError("Facts must be raised by code producers.");
  }
  if (input.kind === "judgment" && producerType === "code") {
    throw new SignalUsageError("Judgments must be raised by agents or observers.");
  }
  if (input.kind === "judgment" && producerClass === "code") {
    throw new SignalUsageError("A judgment cannot use the code producer class.");
  }
  if (severityRank(severity) > severityRank(kindCeiling(input.kind))) {
    throw new SignalUsageError(
      `A ${input.kind} cannot use severity ${severity}; effective ceiling is ${kindCeiling(input.kind)}.`,
    );
  }
  if (severityRank(severity) > severityRank(producerClassCeiling(producerClass))) {
    throw new SignalUsageError(
      `Producer class ${producerClass} cannot use severity ${severity}; effective ceiling is ${producerClassCeiling(producerClass)}.`,
    );
  }
  if (input.kind === "judgment" && (input.escalateAfterMs ?? 0) > 0) {
    throw new SignalUsageError("A judgment cannot escalate out of band.");
  }
  if (isSubjectTerminal(input.subjectType, input.subjectId, now)) {
    throw new SignalUsageError("ENTITY_TERMINAL: the signal subject is terminal or archived.");
  }
  const effective = effectiveSeverity(severity, input.kind, producerClass);
  const detail = input.detail ? sanitizeSignalText(input.detail, 500) : undefined;
  const actor = { actorType: producerType, actorId: producerId };

  const assertSameOwner = (record: SignalRecord) => {
    // A key belongs to one owner and one kind; nobody else may rewrite or reopen it.
    if (record.kind !== input.kind || record.producerId !== producerId) {
      throw new SignalUsageError(
        `Key ${input.key} belongs to a ${record.kind} owned by ${record.producerId}; cross-owner or cross-kind raise is not allowed.`,
      );
    }
  };

  const existing = dbGetNonTerminalSignalByKey(input.key);
  if (existing) {
    assertSameOwner(existing);
    const changes: string[] = [];
    const result = transitionSignal(
      existing.id,
      (draft) => {
        assertSameOwner(draft);
        if (isTerminal(draft)) throw new SignalUsageError(`Signal ${draft.id} closed while it was being raised.`);
        if (title !== draft.title) {
          draft.title = title;
          changes.push("title");
        }
        const nextDetail = detail ?? draft.detail;
        if (nextDetail !== draft.detail) {
          draft.detail = nextDetail;
          changes.push("detail");
        }
        const nextEvidence = input.evidence ?? draft.evidence;
        if (JSON.stringify(nextEvidence) !== JSON.stringify(draft.evidence)) {
          draft.evidence = nextEvidence;
          changes.push("evidence");
        }
        if (JSON.stringify(clearWhen) !== JSON.stringify(draft.clearWhen)) {
          draft.clearWhen = clearWhen;
          changes.push("clearWhen");
        }
        if (effective !== draft.severity) {
          draft.severity = effective;
          changes.push("severity");
        }
        draft.lastSeenAt = now;
        draft.targetSessions = input.targetSessions ?? draft.targetSessions;
        draft.subjectType = input.subjectType ?? draft.subjectType;
        draft.subjectId = input.subjectId ?? draft.subjectId;
        draft.dedupeKey = input.dedupeKey ?? draft.dedupeKey;
      },
      () => ({
        type: changes.length > 0 ? "signal.updated" : "signal.refreshed",
        ...actor,
        message: "re-raise",
        payload: { changed: changes, kind: input.kind, severity: effective, clearWhen },
      }),
      now,
    );
    if (changes.includes("clearWhen")) dbClearSignalObservation(existing.id);
    return { signal: result.signal, created: false, updated: changes.length > 0 };
  }

  const latest = dbGetLatestSignalByKey(input.key);
  if (latest) {
    assertSameOwner(latest);
    // Reopen uses the window stored on the record, never one from this call.
    if (latest.closedAt && now - latest.closedAt < latest.reopenAfterMs) {
      return { signal: latest, created: false, updated: false, suppressed: "reopen" };
    }
    const result = transitionSignal(
      latest.id,
      (draft) => {
        if (!isTerminal(draft)) throw new SignalUsageError(`Signal ${draft.id} reopened concurrently.`);
        Object.assign(draft, freshEpisodeFields(input, { title, detail, clearWhen, effective, now }));
      },
      { type: "signal.reopened", ...actor, message: "raise after reopen_after_ms" },
      now,
    );
    dbClearSignalObservation(latest.id);
    return { signal: result.signal, created: false, updated: true, reopened: true };
  }

  const signal: SignalRecord = {
    id: `sig_${randomUUID().replaceAll("-", "")}`,
    key: input.key,
    schemaVersion: 1,
    kind: input.kind,
    producerType,
    producerClass,
    producerId,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    evidence: input.evidence,
    dedupeKey: input.dedupeKey,
    surfaceCount: 0,
    escalationCount: 0,
    createdAt: now,
    version: 1,
    ...freshEpisodeFields(input, { title, detail, clearWhen, effective, now }),
  } as SignalRecord;
  try {
    dbInsertRaisedSignal(
      signal,
      {
        type: "signal.raised",
        ...actor,
        payload: {
          key: signal.key,
          kind: signal.kind,
          severity: signal.severity,
          scope: `${signal.scopeType}:${signal.scopeId}`,
          clearWhen: signal.clearWhen,
        },
      },
      now,
    );
  } catch (error) {
    // Another producer opened the same key between the read and the insert:
    // treat this call as the re-raise it now is.
    if (error instanceof Error && /UNIQUE/i.test(error.message) && dbGetNonTerminalSignalByKey(input.key)) {
      return raiseSignal(input);
    }
    throw error;
  }
  return { signal: dbGetSignalById(signal.id) ?? signal, created: true, updated: false };
}

function freshEpisodeFields(
  input: RaiseSignalInput,
  resolved: { title: string; detail?: string; clearWhen: ClearWhen; effective: SignalSeverity; now: number },
): Partial<SignalRecord> {
  return {
    title: resolved.title,
    detail: resolved.detail,
    clearWhen: resolved.clearWhen,
    severity: resolved.effective,
    state: "open",
    previousState: undefined,
    targetSessions: input.targetSessions,
    ...(input.evidence ? { evidence: input.evidence } : {}),
    cooldownMs: input.cooldownMs ?? DEFAULT_COOLDOWN_MS[resolved.effective],
    renotifyAfterMs: input.renotifyAfterMs ?? DEFAULT_RENOTIFY_MS[resolved.effective],
    escalateAfterMs:
      input.escalateAfterMs === undefined ? DEFAULT_ESCALATE_MS[resolved.effective] : input.escalateAfterMs,
    maxSurfaces: input.maxSurfaces ?? 3,
    ttlMs: input.ttlMs ?? 24 * 3_600_000,
    reopenAfterMs: input.reopenAfterMs ?? DEFAULT_REOPEN_AFTER_MS,
    mutedUntil: null,
    muteReason: undefined,
    openedAt: resolved.now,
    lastSeenAt: resolved.now,
    surfacedAt: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    closedAt: null,
    closeReason: null,
    updatedAt: resolved.now,
  };
}

export function findSignal(idOrKey: string): SignalRecord | null {
  ensureSignalSchema();
  return dbGetSignalById(idOrKey) ?? dbGetNonTerminalSignalByKey(idOrKey) ?? dbGetLatestSignalByKey(idOrKey);
}

/**
 * The one scope predicate `list`, `show`, `explain`, `ack` and every other
 * per-record command share (invariant 20): the operator sees everything; an
 * agent session sees what resolves to it plus what it owns.
 */
export function signalVisibleTo(signal: SignalRecord, caller: SignalCaller | undefined): boolean {
  if (!caller?.isAgent) return true;
  if (signal.producerId === callerOwnerId(caller)) return true;
  const sessionName = caller.sessionName?.trim();
  // Fail closed: an agent without a resolvable session sees only what it owns.
  if (!sessionName) return false;
  return signalIsInSessionScope(signal, callerSessionContext(caller, sessionName));
}

/** A record outside the caller's scope is NOT_FOUND, exactly like a missing one. */
export function findVisibleSignal(idOrKey: string, caller: SignalCaller | undefined): SignalRecord {
  const signal = findSignal(idOrKey);
  if (!signal || !signalVisibleTo(signal, caller)) throw new SignalNotFoundError(idOrKey);
  return signal;
}

export function listVisibleSignals(
  caller: SignalCaller | undefined,
  options: ListSignalsOptions = {},
): { items: SignalRecord[]; total: number } {
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const { limit: _limit, offset: _offset, ...filters } = options;
  // Filter the whole set before paging, so the page and the total count only
  // what the caller may see.
  const visible = [...dbIterateSignals(filters)].filter((signal) => signalVisibleTo(signal, caller));
  visible.sort((left, right) => right.openedAt - left.openedAt || (right.id < left.id ? -1 : 1));
  return { items: visible.slice(offset, offset + limit), total: visible.length };
}

function assertOwnsRecord(signal: SignalRecord, caller: SignalCaller | undefined, action: string): void {
  if (!caller?.isAgent) return;
  if (signal.producerId !== callerOwnerId(caller)) {
    throw new SignalUsageError(`An agent may ${action} only the signals it raised.`);
  }
}

export function updateSignal(input: {
  idOrKey: string;
  severity?: SignalSeverity;
  title?: string;
  detail?: string;
  evidence?: Record<string, unknown>;
  by?: string;
  caller?: SignalCaller;
  now?: number;
}): SignalRecord {
  const now = input.now ?? Date.now();
  const target = findVisibleSignal(input.idOrKey, input.caller);
  assertOwnsRecord(target, input.caller, "update");
  const title = input.title ? assertSignalTitle(input.title) : undefined;
  return transitionSignal(
    target.id,
    (draft) => {
      if (isTerminal(draft)) throw new SignalUsageError("Cannot update a terminal signal.");
      if (input.severity) {
        const effective = effectiveSeverity(input.severity, draft.kind, draft.producerClass);
        if (severityRank(input.severity) > severityRank(effective)) {
          throw new SignalUsageError(`Severity ${input.severity} exceeds the producer ceiling (${effective}).`);
        }
        draft.severity = effective;
      }
      if (title) draft.title = title;
      if (input.detail !== undefined) draft.detail = sanitizeSignalText(input.detail, 500);
      if (input.evidence) draft.evidence = input.evidence;
    },
    { type: "signal.updated", ...actorFor(input.caller, input.by), message: "update" },
    now,
  ).signal;
}

export function ackSignal(input: {
  idOrKey: string;
  by?: string;
  note?: string;
  caller?: SignalCaller;
  now?: number;
}): { signal: SignalRecord; changed: boolean } {
  const now = input.now ?? Date.now();
  const target = findVisibleSignal(input.idOrKey, input.caller);
  if (input.caller?.isAgent && target.kind === "fact") {
    throw new SignalUsageError("Fact signals require operator acknowledgement. Agents may acknowledge judgments only.");
  }
  const actor = actorFor(input.caller, input.by);
  return transitionSignal(
    target.id,
    (draft) => {
      if (isTerminal(draft)) throw new SignalUsageError(`Cannot acknowledge a ${draft.state} signal.`);
      if (draft.state === "acknowledged") return "noop";
      if (draft.state === "muted") {
        if (draft.previousState === "acknowledged") return "noop";
        draft.previousState = "acknowledged";
      } else {
        draft.state = "acknowledged";
      }
      draft.acknowledgedAt = now;
      draft.acknowledgedBy = actor.actorId;
    },
    {
      type: "signal.acknowledged",
      ...actor,
      message: input.note ? sanitizeSignalText(input.note, 500) : "ack",
    },
    now,
  );
}

export function resolveSignal(input: {
  idOrKey: string;
  reason: string;
  by?: string;
  closeReason?: string;
  caller?: SignalCaller;
  now?: number;
}): SignalRecord {
  const reason = input.reason?.trim();
  if (!reason) throw new SignalUsageError("--reason is required to resolve a signal.");
  const now = input.now ?? Date.now();
  const target = findVisibleSignal(input.idOrKey, input.caller);
  if (input.caller?.isAgent && target.kind === "fact") {
    throw new SignalUsageError(
      "A fact closes by its probe, its producing code, or an operator override; an agent cannot resolve it.",
    );
  }
  return transitionSignal(
    target.id,
    (draft) => {
      if (isTerminal(draft)) return "noop";
      draft.state = "resolved";
      draft.previousState = undefined;
      draft.closedAt = now;
      draft.closeReason = input.closeReason ?? "operator";
    },
    { type: "signal.resolved", ...actorFor(input.caller, input.by), message: sanitizeSignalText(reason, 500) },
    now,
  ).signal;
}

export function muteSignal(input: {
  idOrKey: string;
  forMs: number;
  reason?: string;
  by?: string;
  caller?: SignalCaller;
  now?: number;
}): SignalRecord {
  const now = input.now ?? Date.now();
  if (!Number.isFinite(input.forMs) || input.forMs <= 0) throw new SignalUsageError("--for must be positive.");
  const target = findVisibleSignal(input.idOrKey, input.caller);
  const muteReason = input.reason ? sanitizeSignalText(input.reason, 500) : undefined;
  return transitionSignal(
    target.id,
    (draft) => {
      if (isTerminal(draft)) throw new SignalUsageError(`Cannot mute a ${draft.state} signal.`);
      const previous = draft.state === "muted" ? draft.previousState : draft.state;
      draft.state = "muted";
      draft.previousState =
        previous === "open" || previous === "surfaced" || previous === "acknowledged" ? previous : "open";
      draft.mutedUntil = now + input.forMs;
      draft.muteReason = muteReason;
    },
    (draft) => ({
      type: "signal.muted",
      ...actorFor(input.caller, input.by),
      message: muteReason ?? "mute",
      payload: { mutedUntil: draft.mutedUntil },
    }),
    now,
  ).signal;
}

/** `muted → previous_state`, by an operator or by the mute expiring. */
export function unmuteSignal(input: {
  idOrKey: string;
  by?: string;
  caller?: SignalCaller;
  expired?: boolean;
  now?: number;
}): SignalRecord {
  const now = input.now ?? Date.now();
  const target = input.expired
    ? (findSignal(input.idOrKey) ?? undefined)
    : findVisibleSignal(input.idOrKey, input.caller);
  if (!target) throw new SignalNotFoundError(input.idOrKey);
  return transitionSignal(
    target.id,
    (draft) => {
      if (draft.state !== "muted") return "noop";
      if (input.expired && (!draft.mutedUntil || draft.mutedUntil > now)) return "noop";
      draft.state = draft.previousState ?? "open";
      draft.previousState = undefined;
      draft.mutedUntil = null;
      draft.muteReason = undefined;
    },
    input.expired
      ? { type: "signal.unmuted", actorType: "system", actorId: "signals.tick", message: "mute expired" }
      : { type: "signal.unmuted", ...actorFor(input.caller, input.by), message: "unmute" },
    now,
  ).signal;
}

/** Close a record from the tick or render path (clear rule, ttl, ignored, terminal subject). */
export function closeSignal(
  id: string,
  outcome: { state: "resolved" | "expired"; closeReason: string; message: string; actorId: string },
  now = Date.now(),
): { signal: SignalRecord; changed: boolean } {
  return transitionSignal(
    id,
    (draft) => {
      if (isTerminal(draft)) return "noop";
      draft.state = outcome.state;
      draft.previousState = undefined;
      draft.closedAt = now;
      draft.closeReason = outcome.closeReason;
    },
    {
      type: outcome.state === "resolved" ? "signal.resolved" : "signal.expired",
      actorType: "system",
      actorId: outcome.actorId,
      message: outcome.message,
      payload: { reason: outcome.closeReason },
    },
    now,
  );
}

/** Persist the delivery clamp of a stored severity above its ceilings. */
export function clampSignalSeverity(signal: SignalRecord, actorId: string, now = Date.now()): SignalRecord {
  const effective = effectiveSeverity(signal.severity, signal.kind, signal.producerClass);
  if (effective === signal.severity) return signal;
  return transitionSignal(
    signal.id,
    (draft) => {
      const clamped = effectiveSeverity(draft.severity, draft.kind, draft.producerClass);
      if (clamped === draft.severity) return "noop";
      draft.severity = clamped;
    },
    {
      type: "signal.ceiling_clamped",
      actorType: "system",
      actorId,
      message: `delivery clamped severity to ${effective}`,
    },
    now,
  ).signal;
}

export function listSignals(options: ListSignalsOptions = {}): SignalRecord[] {
  return dbListSignals(options);
}

function positiveIntegerSetting(key: string, fallback: number): number {
  const raw = Number(dbGetSetting(key) ?? fallback);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

/** Daily surface budget (per session), the hard cap render and the tick share. */
export function surfaceBudgetLimit(): number {
  return positiveIntegerSetting("signals.surface_budget_per_day", 3);
}

/** Daily OOB slots across the install. */
export function oobBudgetLimit(): number {
  return positiveIntegerSetting("signals.oob_budget_per_day", 3);
}

export function oobEnabled(): boolean {
  return dbGetSetting("signals.oob_enabled") !== "false";
}

export function getSignalBudget(now = Date.now(), sessionName?: string): SignalBudget {
  ensureSignalSchema();
  const day = budgetDay(now);
  const limit = surfaceBudgetLimit();
  const used = dbCountBudgetUnits(day, sessionName);
  return {
    day,
    used,
    limit,
    held: Math.max(0, used - limit),
    oobUsed: dbCountOobSlots(day),
    oobLimit: oobBudgetLimit(),
  };
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
    status: SignalObservationStatus;
    fields?: Record<string, unknown>;
  };
  tick: { lastSuccessfulTickAt: number | null; staleAfterMs: number; staleAfterSource: string };
  budget: SignalBudget;
  ledgerToday: { pending: number; sent: number; failed: number };
  lastSurfaceAt: number | null;
  lastOobAt: number | null;
  nextSurfaceAt: number | null;
  keyMute: { mutedUntil: number; reason?: string } | null;
  events: ReturnType<typeof dbListSignalEvents>;
}

/** Explain from the stored record, ledger and cached observation; nothing is probed. */
export function explainSignal(idOrKey: string, caller?: SignalCaller, now = Date.now()): SignalExplanation {
  const signal = findVisibleSignal(idOrKey, caller);
  const tickState = dbGetTickState();
  const observation = readSignalObservation(signal, tickState, now);
  let cleared: boolean | null = null;
  const fields = signal.clearWhen.type === "metric" ? signal.evidence : undefined;
  if (observation.status !== "unknown" && signal.clearWhen.type === "probe") {
    cleared = signal.clearSince !== null && signal.clearSince !== undefined;
  } else if (signal.clearWhen.type === "metric" && signal.evidence) {
    const rule = signal.clearWhen;
    const symbol = { gt: ">", gte: ">=", lt: "<", lte: "<=", eq: "==", neq: "!=" }[rule.op];
    cleared = evaluateClearExpression(`${rule.field} ${symbol} ${rule.value}`, signal.evidence);
  } else if (signal.clearWhen.type === "decay") {
    cleared = now - signal.openedAt >= signal.clearWhen.after_ms;
  }
  const lastSurfaceAt = dbGetLastSurfaceAt(signal.id);
  const day = budgetDay(now);
  return {
    signal,
    effectiveSeverity: effectiveSeverity(signal.severity, signal.kind, signal.producerClass),
    targetSessions: resolveSignalTargetSessions(signal),
    clearRule: describeClearRule(signal.clearWhen, signal.openedAt),
    lastEvaluation: {
      at: observation.observedAt,
      error: observation.error,
      cleared,
      status: observation.status,
      ...(fields ? { fields } : {}),
    },
    tick: {
      lastSuccessfulTickAt: tickState.lastSuccessfulTickAt,
      staleAfterMs: tickState.staleAfterMs,
      staleAfterSource: tickState.staleAfterSource,
    },
    budget: getSignalBudget(now),
    ledgerToday: {
      pending: dbCountSignalSurfaces(signal.id, day, "pending"),
      sent: dbCountSignalSurfaces(signal.id, day, "sent"),
      failed: dbCountSignalSurfaces(signal.id, day, "failed"),
    },
    lastSurfaceAt,
    lastOobAt: dbGetLastOobAt(signal.id),
    nextSurfaceAt: lastSurfaceAt === null ? null : lastSurfaceAt + signal.cooldownMs,
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
