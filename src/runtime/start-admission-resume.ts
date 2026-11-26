import { getDb } from "../router/router-db.js";
import {
  claimLocalInboxItem,
  listLocalInboxItems,
  markLocalInboxItem,
  type LocalInboxItem,
} from "../inbox/local-db.js";
import { logger } from "../utils/logger.js";
import type { RuntimeLaunchPrompt } from "./message-types.js";
import { RuntimeStartCapacityError } from "./start-admission.js";
import { classifyTurnProvenance } from "./turn-provenance.js";

const log = logger.child("runtime:start-admission-resume");

/** A request saved for lack of capacity is worth running for this long; after that it expires. */
export const RETAINED_START_TTL_MS = 4 * 60 * 60_000;
export const RETAINED_START_RESUME_INTERVAL_MS = 60_000;
const RETAINED_START_SOURCE_TYPE = "runtime_start_rejected";
// `assigned` means a resume was claimed and may have reached the provider: list it, never run it again.
const OPEN_STATUSES = ["open", "seen", "assigned"] as const;
const RESUMABLE_STATUSES = ["open", "seen"] as const;

export type RetainedStartOutcome = "resumed" | "superseded" | "expired" | "deferred" | "failed" | "invalid";

export interface RetainedStartDecision {
  itemId: string;
  sessionName: string;
  occurredAt: number;
  outcome: RetainedStartOutcome;
  reason?: string;
}

export interface RetainedStartResumeDeps {
  now?(): number;
  ttlMs?: number;
  /**
   * Runs the saved prompt once inside the session's dispatch lane. A RuntimeStartCapacityError means no
   * provider handoff happened; any other error means the turn may have started and must not run again.
   */
  runOnce(sessionName: string, prompt: RuntimeLaunchPrompt): Promise<void>;
  emit(topic: string, payload: Record<string, unknown>): Promise<void>;
}

interface RetainedStartMetadata {
  sessionKey?: unknown;
  sessionName?: unknown;
  prompt?: unknown;
}

function refusedAt(item: LocalInboxItem): number {
  return item.occurredAt ?? item.createdAt;
}

/** Saved capacity refusals still open, oldest first. `resumableOnly` drops the ones already claimed. */
export function listRetainedStarts(options: { resumableOnly?: boolean } = {}): LocalInboxItem[] {
  const statuses: readonly string[] = options.resumableOnly ? RESUMABLE_STATUSES : OPEN_STATUSES;
  return listLocalInboxItems({ sourceDomain: "system", limit: 500 })
    .filter((item) => item.sourceType === RETAINED_START_SOURCE_TYPE)
    .filter((item) => statuses.includes(item.status))
    .sort((a, b) => refusedAt(a) - refusedAt(b));
}

export function retainedStartEnvelope(
  item: LocalInboxItem,
): { sessionName: string; sessionKey: string; prompt: RuntimeLaunchPrompt } | null {
  const metadata = (item.metadata ?? {}) as RetainedStartMetadata;
  const sessionName = typeof metadata.sessionName === "string" ? metadata.sessionName : null;
  const prompt =
    metadata.prompt &&
    typeof metadata.prompt === "object" &&
    typeof (metadata.prompt as { prompt?: unknown }).prompt === "string"
      ? (metadata.prompt as RuntimeLaunchPrompt)
      : null;
  if (!sessionName || !prompt) return null;
  const sessionKey = typeof metadata.sessionKey === "string" ? metadata.sessionKey : sessionName;
  return { sessionName, sessionKey, prompt };
}

/** True when the session started another turn after this request was refused: the person was already served. */
export function sessionTurnStartedAfter(sessionKey: string, refusedAt: number): boolean {
  const row = getDb()
    .prepare("SELECT 1 AS hit FROM session_turns WHERE session_key = ? AND started_at > ? LIMIT 1")
    .get(sessionKey, refusedAt) as { hit?: number } | null;
  return Boolean(row?.hit);
}

/** Decide what to do with one saved request without running it. Pure apart from the session_turns read. */
export function classifyRetainedStart(
  item: LocalInboxItem,
  now: number,
  ttlMs: number = RETAINED_START_TTL_MS,
): RetainedStartDecision & { envelope: ReturnType<typeof retainedStartEnvelope> } {
  const envelope = retainedStartEnvelope(item);
  const base = {
    itemId: item.id,
    sessionName: envelope?.sessionName ?? String((item.metadata as RetainedStartMetadata)?.sessionName ?? "?"),
    occurredAt: refusedAt(item),
    envelope,
  };
  if (!envelope) return { ...base, outcome: "invalid", reason: "saved envelope is missing session or prompt" };
  if (now - refusedAt(item) > ttlMs) return { ...base, outcome: "expired" };
  if (sessionTurnStartedAfter(envelope.sessionKey, refusedAt(item))) return { ...base, outcome: "superseded" };
  return { ...base, outcome: "resumed" };
}

function closeRetainedStart(
  item: LocalInboxItem,
  status: "done" | "archived",
  outcome: RetainedStartOutcome,
  extra = {},
) {
  markLocalInboxItem(item.id, status, {
    eventType: `resume_${outcome}`,
    payload: { status, outcome, ...extra },
  });
}

/**
 * One pass over saved capacity refusals, oldest first. Each request runs at most once: the item is claimed
 * before the attempt, and only a capacity refusal (no provider handoff) puts it back. The first capacity refusal
 * ends the pass, since the next requests would meet the same full pool.
 */
export async function resumeRetainedStarts(deps: RetainedStartResumeDeps): Promise<RetainedStartDecision[]> {
  const now = deps.now?.() ?? Date.now();
  const ttlMs = deps.ttlMs ?? RETAINED_START_TTL_MS;
  const decisions: RetainedStartDecision[] = [];
  for (const item of listRetainedStarts({ resumableOnly: true })) {
    const decision = classifyRetainedStart(item, now, ttlMs);
    const { envelope, ...report } = decision;
    if (decision.outcome === "invalid") {
      closeRetainedStart(item, "archived", "invalid", { reason: decision.reason });
      decisions.push(report);
      continue;
    }
    if (decision.outcome === "expired") {
      closeRetainedStart(item, "archived", "expired", { ttlMs });
      await notifyExpired(deps, item, envelope!);
      decisions.push(report);
      continue;
    }
    if (decision.outcome === "superseded") {
      closeRetainedStart(item, "done", "superseded");
      await deps
        .emit(`ravi.session.${envelope!.sessionName}.runtime`, {
          type: "dispatch.resume_superseded",
          receipt: item.id,
          providerHandoff: false,
          timestamp: new Date(now).toISOString(),
        })
        .catch((error) => log.warn("Failed to emit retained start event", { error }));
      decisions.push(report);
      continue;
    }
    // Claim before running: a second pass or a second daemon must not run the same request.
    if (!claimLocalInboxItem(item.id, ["open", "seen"], "assigned", { eventType: "resume_claimed" })) continue;
    try {
      await deps.runOnce(envelope!.sessionName, envelope!.prompt);
      closeRetainedStart(item, "done", "resumed");
      decisions.push(report);
    } catch (error) {
      if (error instanceof RuntimeStartCapacityError) {
        markLocalInboxItem(item.id, "open", {
          eventType: "resume_deferred",
          payload: { status: "open", outcome: "deferred", reason: error.capacity.reason },
        });
        decisions.push({ ...report, outcome: "deferred", reason: error.capacity.reason });
        break;
      }
      // The turn may already have reached the provider: never run it a second time.
      log.warn("Saved request failed on resume; not retrying", { itemId: item.id, error });
      closeRetainedStart(item, "done", "failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      decisions.push({ ...report, outcome: "failed", reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return decisions;
}

async function notifyExpired(
  deps: RetainedStartResumeDeps,
  item: LocalInboxItem,
  envelope: { sessionName: string; prompt: RuntimeLaunchPrompt },
): Promise<void> {
  await deps
    .emit(`ravi.session.${envelope.sessionName}.runtime`, {
      type: "dispatch.resume_expired",
      receipt: item.id,
      providerHandoff: false,
      timestamp: new Date().toISOString(),
    })
    .catch((error) => log.warn("Failed to emit retained start event", { error }));
  // Only a person waits for this; automation turns have no one to tell (same rule as the refusal receipt).
  const prompt = envelope.prompt;
  if (!prompt.source || classifyTurnProvenance({ prompt }).background === true) return;
  await deps
    .emit(`ravi.session.${envelope.sessionName}.response`, {
      response: `Seu pedido salvo (recibo ${item.id}) não pôde ser retomado a tempo por falta de capacidade. Se ainda precisar, envie de novo.`,
      target: prompt.source,
      _emitId: `capacity-expired:${item.id}`,
      _pid: process.pid,
      _v: 2,
    })
    .catch((error) => log.warn("Failed to emit retained start event", { error }));
}
