import type { HitlRequiredWhen, SendWindow } from "./pipeline-metadata.js";

/**
 * Pure runtime evaluators for `pipeline.metadata` policies.
 *
 * These are exported so any consumer (TypeScript dispatcher, CLI, future
 * Python adapter via JSON bridge) can apply the same rules without
 * duplicating logic.
 *
 * Design:
 * - Pure: no I/O, no globals. Decisions only depend on inputs.
 * - Fail-open by default: missing policy = ALLOW (preserves backward compat).
 * - Deterministic timezone handling using Intl.DateTimeFormat.
 */

export interface SendWindowDecision {
  allowed: boolean;
  reason: string;
  releaseAtIso?: string;
  evaluatedAtIso: string;
  timezone: string;
}

const WEEKDAY_INDEX: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

function parseDaysRange(range: string): Set<number> {
  const allowed = new Set<number>();
  const lc = range.toLowerCase();
  const dashIdx = lc.indexOf("-");
  if (dashIdx === -1) {
    const idx = WEEKDAY_INDEX[lc];
    if (idx !== undefined) allowed.add(idx);
    return allowed;
  }
  const startKey = lc.slice(0, dashIdx);
  const endKey = lc.slice(dashIdx + 1);
  const startIdx = WEEKDAY_INDEX[startKey];
  const endIdx = WEEKDAY_INDEX[endKey];
  if (startIdx === undefined || endIdx === undefined) return allowed;
  // Inclusive wrap-around (e.g. fri-mon = fri, sat, sun, mon).
  let cur = startIdx;
  for (let safety = 0; safety < 8; safety++) {
    allowed.add(cur);
    if (cur === endIdx) break;
    cur = (cur + 1) % 7;
  }
  return allowed;
}

function parseHoursRange(range: string): { start: number; end: number } | null {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(range);
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || start > 23 || end < 1 || end > 24) return null;
  return { start, end };
}

interface TzParts {
  hour: number;
  weekdayIndex: number;
  invalidTz?: boolean;
}

function getZonedParts(date: Date, timezone: string): TzParts {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      hour12: false,
      weekday: "short",
    });
    const parts = formatter.formatToParts(date);
    const hourPart = parts.find((p) => p.type === "hour")?.value ?? "00";
    const weekdayPart = parts.find((p) => p.type === "weekday")?.value?.toLowerCase() ?? "mon";
    const hour = Number(hourPart);
    const weekdayIndex = WEEKDAY_INDEX[weekdayPart.slice(0, 3)] ?? 1;
    return {
      hour: Number.isFinite(hour) ? hour : 0,
      weekdayIndex,
    };
  } catch {
    // Invalid timezone — fall back to UTC but mark for caller to surface a
    // distinct reason (review m2). Engine still never throws.
    return {
      hour: date.getUTCHours(),
      weekdayIndex: date.getUTCDay(),
      invalidTz: true,
    };
  }
}

function hourInRange(hour: number, start: number, end: number): boolean {
  // Supports midnight-wrap windows like 22-6 (10pm-6am) by treating end<=start
  // as "[start..24) ∪ [0..end)" (review M3 midnight-wrap).
  if (end > start) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

/**
 * Evaluate a `send_window` policy at a given instant.
 *
 * Returns `{allowed: true}` when:
 * - `window` is undefined or null (fail-open: no policy = ALLOW).
 * - The instant falls within `window.hours` (inclusive start, exclusive end)
 *   AND within `window.days` if declared (default: all days allowed).
 *
 * Returns `{allowed: false, releaseAtIso}` when the instant falls outside
 * the window. `releaseAtIso` is the next instant when sending becomes
 * allowed (used by dispatcher to schedule requeue).
 */
export function evaluateSendWindow(
  window: SendWindow | undefined | null,
  evaluatedAt: Date = new Date(),
): SendWindowDecision {
  if (!window) {
    return {
      allowed: true,
      reason: "no_send_window_declared",
      evaluatedAtIso: evaluatedAt.toISOString(),
      timezone: "UTC",
    };
  }
  const timezone = window.timezone;
  const hours = parseHoursRange(window.hours);
  if (!hours) {
    return {
      allowed: true,
      reason: "invalid_hours_format_failopen",
      evaluatedAtIso: evaluatedAt.toISOString(),
      timezone,
    };
  }
  const allowedDays = window.days ? parseDaysRange(window.days) : null;
  const parts = getZonedParts(evaluatedAt, timezone);

  if (parts.invalidTz) {
    return {
      allowed: true,
      reason: "invalid_timezone_failopen",
      evaluatedAtIso: evaluatedAt.toISOString(),
      timezone,
    };
  }

  const dayOk = allowedDays === null || allowedDays.has(parts.weekdayIndex);
  const hourOk = hourInRange(parts.hour, hours.start, hours.end);

  if (dayOk && hourOk) {
    return {
      allowed: true,
      reason: "within_window",
      evaluatedAtIso: evaluatedAt.toISOString(),
      timezone,
    };
  }

  // Compute next allowed instant. Strategy: bump hour-by-hour up to 7 days.
  for (let bump = 1; bump <= 24 * 7; bump++) {
    const candidate = new Date(evaluatedAt.getTime() + bump * 60 * 60 * 1000);
    const cParts = getZonedParts(candidate, timezone);
    if (cParts.invalidTz) break;
    const cDayOk = allowedDays === null || allowedDays.has(cParts.weekdayIndex);
    const cHourOk = hourInRange(cParts.hour, hours.start, hours.end);
    if (cDayOk && cHourOk) {
      return {
        allowed: false,
        reason: hourOk ? "outside_allowed_days" : "outside_allowed_hours",
        releaseAtIso: candidate.toISOString(),
        evaluatedAtIso: evaluatedAt.toISOString(),
        timezone,
      };
    }
  }

  return {
    allowed: false,
    reason: "no_window_match_in_7d_lookahead",
    evaluatedAtIso: evaluatedAt.toISOString(),
    timezone,
  };
}

// --------------------------- HITL required when ---------------------------

export interface HitlContext {
  /** Free-form context (e.g. contact tags, derivations) consumed by condition evaluators */
  [key: string]: unknown;
}

export interface HitlDecision {
  hitlRequired: boolean;
  matchedConditions: number;
  reasons: string[];
}

/**
 * Evaluate the `hitl_required_when` declarative rules.
 *
 * Each condition in `rules.conditions` is a key/value map applied to the
 * provided `context`. Supported atom forms (extend as needed):
 *
 * - `{has_tag: "<tag>"}` — true if `context.tags` (array) contains `<tag>`.
 * - `{lacks_tag: "<tag>"}` — true if `context.tags` does NOT contain `<tag>`.
 * - `{contact_value_above: <number>}` — true if `context.contact_value` > N.
 * - `{ltv_above: <number>}` — true if `context.ltv` > N.
 *
 * If ANY condition matches, HITL is required (logical OR).
 *
 * Unknown atom keys are ignored (fail-open) — never throw.
 */
export function evaluateHitlRequiredWhen(
  rules: HitlRequiredWhen | undefined | null,
  context: HitlContext,
): HitlDecision {
  if (!rules || !Array.isArray(rules.conditions) || rules.conditions.length === 0) {
    return { hitlRequired: false, matchedConditions: 0, reasons: [] };
  }

  const reasons: string[] = [];
  for (const atom of rules.conditions) {
    const matched = evaluateConditionAtom(atom, context);
    if (matched) {
      reasons.push(matched);
    }
  }

  return {
    hitlRequired: reasons.length > 0,
    matchedConditions: reasons.length,
    reasons,
  };
}

function evaluateConditionAtom(atom: Record<string, unknown>, ctx: HitlContext): string | null {
  if (typeof atom !== "object" || atom === null) return null;

  const tags = Array.isArray(ctx.tags) ? (ctx.tags as string[]) : [];

  if (typeof atom.has_tag === "string") {
    return tags.includes(atom.has_tag) ? `has_tag:${atom.has_tag}` : null;
  }
  if (typeof atom.lacks_tag === "string") {
    return tags.includes(atom.lacks_tag) ? null : `lacks_tag:${atom.lacks_tag}`;
  }
  if (typeof atom.contact_value_above === "number") {
    const v = typeof ctx.contact_value === "number" ? ctx.contact_value : null;
    if (v !== null && v > atom.contact_value_above) {
      return `contact_value_above:${atom.contact_value_above}`;
    }
    return null;
  }
  if (typeof atom.ltv_above === "number") {
    const v = typeof ctx.ltv === "number" ? ctx.ltv : null;
    if (v !== null && v > atom.ltv_above) {
      return `ltv_above:${atom.ltv_above}`;
    }
    return null;
  }

  // Unknown atom shape — fail-open, ignored (does not contribute to HITL).
  return null;
}
