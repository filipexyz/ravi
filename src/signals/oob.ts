import { randomUUID } from "node:crypto";
import { buildSignalTurnOrigin } from "../runtime/turn-origin.js";
import { publishSessionPrompt } from "../omni/session-stream.js";
import type { SignalOutboxRecord, SignalRecord, SignalSeverity, SignalTickState } from "./types.js";
import { effectiveSeverity, kindCeiling, minSeverity, producerClassCeiling } from "./validation.js";
import {
  budgetDay,
  dbConfirmSignalSurface,
  dbGetKeyMute,
  dbGetOutboxRow,
  dbGetSignalById,
  dbListPendingOutbox,
  dbRecordOutboxAttempt,
  dbClaimOutboxRow,
  dbOwnsOutboxClaim,
  dbReleaseOutboxClaim,
  dbRecordOutboxPage,
  dbReleaseSignalSurface,
  dbReserveSignalSurface,
} from "./signal-db.js";
import { isSubjectTerminal, resolveSignalTargetSessions } from "./subjects.js";
import { describeClearRule } from "./probes.js";
import { sendSignalPage } from "./page.js";
import { readSignalObservation } from "./observation.js";
import { oobBudgetLimit, oobEnabled, surfaceBudgetLimit } from "./service.js";

const OOB_ACTOR = "signals.tick";
/** Attempts before a pending OOB row is failed and its reservation returned. */
export const SIGNAL_OUTBOX_MAX_ATTEMPTS = 3;
/** A pending row older than this is expired (failed), never sent late. */
export const SIGNAL_OUTBOX_MAX_AGE_MS = 24 * 3_600_000;

export type SignalPagePublisher = (
  signal: SignalRecord,
  sessionName: string,
  idempotencyKey: string,
) => Promise<"sent" | "skipped_no_binding" | "failed">;

export type SignalPromptPublisher = (
  sessionName: string,
  payload: Record<string, unknown>,
  options?: { messageId?: string },
) => Promise<void>;

export interface DeliverOobResult {
  delivered: boolean;
  signalId?: string;
  outcome: "sent" | "retry" | "failed" | "skipped";
  reason?: string;
  route?: "oob" | "page";
  severity?: SignalSeverity;
  pageLine?: "sent" | "skipped_no_binding" | "failed";
}

/** The OOB prompt, built from what actually happened to the page line, never from intent. */
export function buildSignalOobPrompt(
  signal: SignalRecord,
  severity: SignalSeverity,
  pageLine?: DeliverOobResult["pageLine"],
): string {
  const lines = [
    `[System] Inform: [signal:${signal.id}] ${severity} ${signal.title}.`,
    signal.detail ? signal.detail : "",
    `Closes when ${describeClearRule(signal.clearWhen, signal.openedAt)}.`,
    `Ack: ravi signals ack ${signal.id}.`,
  ].filter(Boolean);
  // Only a page that actually went out lets the agent skip the alert; an
  // interrupt has no page line, and a skipped or failed page reached nobody.
  if (pageLine === "sent") {
    lines.push(
      "The operator already received the one-line notice. Add context only; do not repeat the alert verbatim.",
    );
  } else if (severity === "interrupt" || severity === "page") {
    lines.push("The operator has not received a notice for this signal. Tell the operator now.");
  }
  return lines.join("\n");
}

export function oobDeliverySeverity(signal: SignalRecord, routeSeverity?: SignalSeverity): SignalSeverity {
  const effective = effectiveSeverity(signal.severity, signal.kind, signal.producerClass);
  const ceiling = minSeverity(kindCeiling(signal.kind), producerClassCeiling(signal.producerClass));
  const current = effective === "piggyback" && signal.escalateAfterMs != null ? "nudge" : effective;
  return minSeverity(minSeverity(routeSeverity ?? current, current), ceiling);
}

function isOobSeverity(severity: SignalSeverity): boolean {
  return severity === "nudge" || severity === "interrupt" || severity === "page";
}

/**
 * Reserve one OOB surface: ledger row `pending` plus outbox row, with the
 * surface budget and the daily OOB slot checked in the same transaction. A
 * `page` on a fact with a fresh, successful evaluation is the one audited
 * budget bypass.
 */
export function reserveSignalOob(input: {
  signal: SignalRecord;
  sessionName: string;
  routeSeverity: SignalSeverity;
  freshEvaluation: boolean;
  now: number;
}):
  | { reserved: true; outboxId: number; severity: SignalSeverity }
  | { reserved: false; reason: "budget" | "oob_budget" | "pending" | "ineligible" } {
  const severity = oobDeliverySeverity(input.signal, input.routeSeverity);
  if (!isOobSeverity(severity)) return { reserved: false, reason: "ineligible" };
  const route = severity === "page" ? "page" : "oob";
  const surfaceLimit = surfaceBudgetLimit();
  const oobLimit = oobBudgetLimit();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = attempt === 0 ? input.signal : dbGetSignalById(input.signal.id);
    if (!current) return { reserved: false, reason: "ineligible" };
    const outcome = dbReserveSignalSurface({
      signalId: current.id,
      expectedVersion: current.version,
      route,
      severity,
      sessionName: input.sessionName,
      idempotencyKey: (sequence) => `signal:${current.id}:${route}:${budgetDay(input.now)}:${sequence}`,
      decide: ({ budgetUnits, oobSlots, signal }) => {
        if (route === "page" && signal.kind === "fact" && input.freshEvaluation) {
          return { ok: true, budgetBypass: true };
        }
        if (budgetUnits >= surfaceLimit) return { ok: false, reason: "budget" };
        if (oobSlots >= oobLimit) return { ok: false, reason: "oob_budget" };
        return { ok: true };
      },
      actorId: OOB_ACTOR,
      now: input.now,
    });
    if ("reserved" in outcome) return { reserved: true, outboxId: outcome.reserved.outboxId, severity };
    if (outcome.skipped !== "stale_version") return { reserved: false, reason: outcome.skipped };
  }
  return { reserved: false, reason: "ineligible" };
}

/**
 * Re-validate a reservation before (re)sending it: the record must still be
 * open, unmuted, OOB-capable and backed by a fresh, successful evaluation.
 */
function revalidate(
  signal: SignalRecord | null,
  row: SignalOutboxRecord,
  tickState: SignalTickState,
  now: number,
  evaluatedAt?: number,
): string | null {
  if (!signal) return "signal missing";
  if (signal.state === "resolved" || signal.state === "expired") return `signal ${signal.state}`;
  if (signal.state === "muted") return "signal muted";
  if (!row.sessionName || !resolveSignalTargetSessions(signal).includes(row.sessionName)) return "target changed";
  if (row.createdAt < signal.openedAt) return "signal reopened";
  if (isSubjectTerminal(signal.subjectType, signal.subjectId, now)) return "subject terminal";
  if (now - signal.lastSeenAt >= signal.ttlMs) return "signal expired";
  if (signal.escalateAfterMs == null || now - signal.openedAt < signal.escalateAfterMs) return "not due";
  if (dbGetKeyMute(signal.key, now)) return "key muted";
  // Operator decisions made since the reservation hold on every retry.
  if (!oobEnabled()) return "oob disabled";
  if (
    signal.state === "acknowledged" &&
    typeof signal.acknowledgedAt === "number" &&
    now - signal.acknowledgedAt < signal.renotifyAfterMs
  ) {
    return "acknowledged";
  }
  if (signal.kind !== "fact") return "judgment cannot escalate";
  const severity = oobDeliverySeverity(signal, row.severity);
  if (!isOobSeverity(severity)) return "below oob ceiling";
  // A page's audited budget bypass cannot become a free nudge/interrupt.
  if (severity !== row.severity) return "delivery severity changed";
  const observation = readSignalObservation(signal, tickState, now, { evaluatedAt });
  if (observation.status !== "fresh") return `observation ${observation.status}`;
  return null;
}

/**
 * Send one outbox row: the only path that delivers an OOB surface (and its
 * retries). A retryable failure keeps the row `pending` under the same key; a
 * terminal failure, expiry or failed re-validation releases the reservation.
 */
export async function deliverSignalOutboxRow(input: {
  outboxId: number;
  tickState: SignalTickState;
  now: number;
  evaluatedAt?: number;
  publishPrompt?: SignalPromptPublisher;
  sendPage?: SignalPagePublisher;
}): Promise<DeliverOobResult> {
  const claim = randomUUID();
  if (!dbClaimOutboxRow(input.outboxId, claim, input.now, 10 * 60_000)) {
    return { delivered: false, outcome: "skipped", reason: "not pending or already claimed" };
  }
  try {
    return await deliverClaimedSignalOutboxRow(input, claim);
  } finally {
    dbReleaseOutboxClaim(input.outboxId, claim);
  }
}

async function deliverClaimedSignalOutboxRow(
  input: Parameters<typeof deliverSignalOutboxRow>[0],
  claim: string,
): Promise<DeliverOobResult> {
  const row = dbGetOutboxRow(input.outboxId);
  if (!row || row.status !== "pending") return { delivered: false, outcome: "skipped", reason: "not pending" };
  const route = row.route === "page" ? "page" : "oob";
  const release = (reason: string): DeliverOobResult => {
    dbReleaseSignalSurface({ surfaceId: row.surfaceId, reason, actorId: OOB_ACTOR, now: input.now });
    return { delivered: false, outcome: "failed", reason, route, severity: row.severity };
  };
  if (input.now - row.createdAt > SIGNAL_OUTBOX_MAX_AGE_MS) return release("reservation expired");

  let signal = dbGetSignalById(row.signalId);
  // The version moved since the reservation (an operator acted, a producer
  // re-raised): re-read and re-validate before any side effect.
  const invalid = revalidate(signal, row, input.tickState, input.now, input.evaluatedAt);
  if (invalid || !signal) return release(invalid ?? "signal missing");
  const reservedVersion = signal.version !== row.reservedVersion ? signal.version : undefined;

  const severity = oobDeliverySeverity(signal, row.severity);
  const sessionName = row.sessionName ?? "";
  const lastAttempt = row.attempts + 1 >= SIGNAL_OUTBOX_MAX_ATTEMPTS;
  let pageLine = row.pageStatus ?? undefined;
  if (route === "page" && pageLine !== "sent" && pageLine !== "skipped_no_binding") {
    const sender: SignalPagePublisher = input.sendPage ?? sendSignalPage;
    pageLine = await sender(signal, sessionName, `signal-page:${row.idempotencyKey}`).catch(() => "failed" as const);
    if (!dbOwnsOutboxClaim(row.id, claim)) return { delivered: false, outcome: "skipped", reason: "claim lost" };
    dbRecordOutboxPage(row.id, pageLine, input.now);
    if (pageLine === "failed" && !lastAttempt) {
      dbRecordOutboxAttempt({
        outboxId: row.id,
        error: "page line failed",
        pageStatus: pageLine,
        reservedVersion,
        now: input.now,
      });
      return { delivered: false, outcome: "retry", reason: "page line failed", route, severity, pageLine };
    }
  }

  // Page delivery awaits transport. Re-read before the second side effect so
  // an operator mute, retarget, close or downgrade made during that wait wins.
  signal = dbGetSignalById(row.signalId);
  const changed = revalidate(signal, row, input.tickState, input.now, input.evaluatedAt);
  if (changed || !signal) return release(changed ?? "signal missing");

  const publish: SignalPromptPublisher =
    input.publishPrompt ??
    ((name, payload, options) => publishSessionPrompt(name, payload, options?.messageId ? options : {}));
  try {
    await publish(
      sessionName,
      {
        prompt: buildSignalOobPrompt(signal, severity, pageLine),
        deliveryBarrier: severity === "nudge" ? "after_response" : "immediate_interrupt",
        deliveryBarrierSource: "explicit",
        _turnOrigin: buildSignalTurnOrigin(signal.id),
        _signal: { id: signal.id, key: signal.key, severity, route, idempotencyKey: row.idempotencyKey },
      },
      { messageId: row.idempotencyKey },
    );
  } catch (error) {
    if (!dbOwnsOutboxClaim(row.id, claim)) return { delivered: false, outcome: "skipped", reason: "claim lost" };
    const message = error instanceof Error ? error.message : String(error);
    if (lastAttempt) return release(`publish failed: ${message}`);
    dbRecordOutboxAttempt({ outboxId: row.id, error: message, pageStatus: pageLine, reservedVersion, now: input.now });
    return { delivered: false, outcome: "retry", reason: message, route, severity, pageLine };
  }

  if (!dbOwnsOutboxClaim(row.id, claim)) return { delivered: false, outcome: "skipped", reason: "claim lost" };
  dbConfirmSignalSurface({
    surfaceId: row.surfaceId,
    actorId: OOB_ACTOR,
    now: input.now,
    pageStatus: pageLine ?? null,
    payload: { severity, attempts: row.attempts + 1 },
  });
  return { delivered: true, outcome: "sent", route, severity, pageLine };
}

/** Drain every pending OOB outbox row (the retry path). */
export async function drainSignalOutbox(input: {
  tickState: SignalTickState;
  now: number;
  evaluatedAt?: number;
  publishPrompt?: SignalPromptPublisher;
  sendPage?: SignalPagePublisher;
}): Promise<DeliverOobResult[]> {
  const results: DeliverOobResult[] = [];
  for (const row of dbListPendingOutbox(["oob", "page"])) {
    results.push({ ...(await deliverSignalOutboxRow({ ...input, outboxId: row.id })), signalId: row.signalId });
  }
  return results;
}
