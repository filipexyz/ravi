/**
 * Cron Turn Outcome
 *
 * Maps runtime terminal events (`ravi.session.<name>.runtime`) back to the
 * cron job whose prompt caused the turn. The cron runner uses this to record
 * the real agent turn outcome instead of treating a successful prompt
 * dispatch as a successful run.
 */

import type { JobOutcomeUpdate } from "./types.js";

/** Wildcard subject covering runtime events for every session. */
export const CRON_RUNTIME_EVENTS_TOPIC = "ravi.session.*.runtime";

const RUNTIME_TOPIC_PREFIX = "ravi.session.";
const RUNTIME_TOPIC_SUFFIX = ".runtime";
const CRON_AUTOMATION_ID_PREFIX = "cron:";
const MAX_ERROR_CHARS = 2000;

export type CronTurnTerminalKind = "complete" | "failed" | "interrupted";

/**
 * How the event relates to cron turn provenance.
 * - `cron`: the turn was caused by a cron prompt; `jobId` identifies the job.
 * - `other`: the turn was caused by something else (human, trigger, ...).
 * - `none`: no provenance at all, which happens for failures raised before a
 *   turn started (runtime launch failures, prompt dispatch failures).
 */
export type CronTurnProvenanceMatch = "cron" | "other" | "none";

export interface CronTurnOutcome {
  kind: CronTurnTerminalKind;
  sessionName: string;
  provenance: CronTurnProvenanceMatch;
  jobId?: string;
  error?: string;
  reason?: string;
}

const TERMINAL_KINDS: Record<string, CronTurnTerminalKind> = {
  "turn.complete": "complete",
  "turn.failed": "failed",
  "turn.interrupted": "interrupted",
};

export function parseRuntimeSessionName(topic: string): string | undefined {
  if (!topic.startsWith(RUNTIME_TOPIC_PREFIX) || !topic.endsWith(RUNTIME_TOPIC_SUFFIX)) return undefined;
  const sessionName = topic.slice(RUNTIME_TOPIC_PREFIX.length, topic.length - RUNTIME_TOPIC_SUFFIX.length);
  return sessionName.length > 0 ? sessionName : undefined;
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function truncateError(value: string): string {
  if (value.length <= MAX_ERROR_CHARS) return value;
  return `${value.slice(0, MAX_ERROR_CHARS)}... [truncated]`;
}

function extractRuntimeError(data: Record<string, unknown>): string | undefined {
  const direct = data.error;
  const asString = cleanString(direct);
  if (asString) return truncateError(asString);
  if (direct && typeof direct === "object") {
    const message = cleanString((direct as { message?: unknown }).message);
    if (message) return truncateError(message);
  }
  return undefined;
}

function resolveProvenance(data: Record<string, unknown>): Pick<CronTurnOutcome, "provenance" | "jobId"> {
  const provenance = data._turnProvenance;
  if (!provenance || typeof provenance !== "object") return { provenance: "none" };

  const record = provenance as { origin?: unknown; automationId?: unknown };
  const automationId = cleanString(record.automationId);
  if (automationId?.startsWith(CRON_AUTOMATION_ID_PREFIX)) {
    const jobId = cleanString(automationId.slice(CRON_AUTOMATION_ID_PREFIX.length));
    return jobId ? { provenance: "cron", jobId } : { provenance: "cron" };
  }
  if (record.origin === "cron") return { provenance: "cron" };
  return { provenance: "other" };
}

/**
 * Parse a runtime event into a cron turn outcome.
 * Returns null for non-terminal events and for subjects outside the runtime topic.
 */
export function parseCronTurnOutcome(event: { topic: string; data: unknown }): CronTurnOutcome | null {
  if (!event.data || typeof event.data !== "object") return null;
  const data = event.data as Record<string, unknown>;
  const kind = typeof data.type === "string" ? TERMINAL_KINDS[data.type] : undefined;
  if (!kind) return null;

  const sessionName = parseRuntimeSessionName(event.topic);
  if (!sessionName) return null;

  const error = extractRuntimeError(data);
  const reason = cleanString(data.reason);
  return {
    kind,
    sessionName,
    ...resolveProvenance(data),
    ...(error ? { error } : {}),
    ...(reason ? { reason } : {}),
  };
}

export interface BuildCronTurnOutcomeStateOptions {
  /** Epoch ms when the job prompt was dispatched; used for `lastDurationMs`. */
  dispatchedAt?: number;
  /** Epoch ms of the terminal event; defaults to now. */
  now?: number;
}

/**
 * Translate a terminal turn outcome into the job state update to persist.
 * Interrupted turns did not finish the job's work, so they count as errors.
 */
export function buildCronTurnOutcomeState(
  outcome: Pick<CronTurnOutcome, "kind" | "error" | "reason">,
  options: BuildCronTurnOutcomeStateOptions = {},
): JobOutcomeUpdate {
  const now = options.now ?? Date.now();
  const lastDurationMs =
    options.dispatchedAt !== undefined && Number.isFinite(options.dispatchedAt)
      ? Math.max(0, now - options.dispatchedAt)
      : undefined;
  const durationField = lastDurationMs === undefined ? {} : { lastDurationMs };

  if (outcome.kind === "complete") {
    return { lastStatus: "ok", ...durationField };
  }

  if (outcome.kind === "failed") {
    return {
      lastStatus: "error",
      lastError: outcome.error ?? (outcome.reason ? `Agent turn failed (${outcome.reason})` : "Agent turn failed"),
      ...durationField,
    };
  }

  const interruptedBase = outcome.reason ? `Agent turn interrupted (${outcome.reason})` : "Agent turn interrupted";
  return {
    lastStatus: "error",
    lastError: outcome.error ? `${interruptedBase}: ${outcome.error}` : interruptedBase,
    ...durationField,
  };
}
