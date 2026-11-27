/**
 * Reset-time evidence for exhausted or rate-limited runtime credentials.
 *
 * A credential that hit a provider limit must become eligible again when the
 * provider says the limit resets, not after a fixed guess. Two sources carry
 * that time:
 *
 * - structured provider events (Claude `rate_limit_event.rate_limit_info.resetsAt`,
 *   which the Claude CLI stores in epoch seconds and renders with `resetsAt * 1000`);
 * - the provider notice text ("resets 2pm (America/Sao_Paulo)",
 *   "resets Nov 30 at 6am (America/Sao_Paulo)").
 *
 * Both parsers return epoch milliseconds or `undefined`; they never guess.
 */

const SECONDS_EPOCH_MIN = 1_000_000_000; // 2001-09-09 in seconds
const MILLISECONDS_EPOCH_MIN = 1_000_000_000_000; // 2001-09-09 in milliseconds

/**
 * Text that names a reset hour that already passed by more than this is read as
 * the next day (or next year for a dated reset). Inside the window, the hour is
 * kept: a notice that says "resets 2pm" read at 14:02 means the limit just reset,
 * not that it resets tomorrow.
 */
const PAST_RESET_GRACE_MS = 60 * 60_000;

/** Provider limit windows are at most weekly; anything further is not trusted. */
const MAX_RESET_HORIZON_MS = 32 * 24 * 60 * 60_000;

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

const RESET_TEXT_PATTERN =
  /\bresets?\s+(?:at\s+|on\s+)?(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*)\))?/i;

/**
 * Normalizes a provider reset timestamp to epoch milliseconds.
 *
 * Values in `[1e9, 1e12)` are epoch seconds and values `>= 1e12` are epoch
 * milliseconds. The ranges do not overlap for any date after 2001, so the unit
 * is unambiguous. Anything else is rejected.
 */
export function normalizeProviderResetEpochMs(value: unknown): number | undefined {
  const numeric = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof numeric !== "number" || !Number.isFinite(numeric)) return undefined;
  if (numeric >= MILLISECONDS_EPOCH_MIN) return Math.round(numeric);
  if (numeric >= SECONDS_EPOCH_MIN) return Math.round(numeric * 1000);
  return undefined;
}

/**
 * Parses "resets <time> [(<IANA zone>)]" and "resets <Mon> <day> at <time> [(<IANA zone>)]"
 * from a provider notice. Without a zone, the host zone is used: the Claude CLI
 * renders the notice in the zone of the process that runs it, which is this host.
 *
 * Returns `undefined` when the text has no reset clause, the time has neither
 * `am/pm` nor `:mm` (so "resets 3 days" never parses), the zone is unknown, or
 * the result falls outside a sane horizon.
 */
export function parseProviderResetTextEpochMs(
  message: string | undefined,
  now: number,
  hostTimeZone: string = resolveHostTimeZone(),
): number | undefined {
  if (!message) return undefined;
  const match = message.match(RESET_TEXT_PATTERN);
  if (!match) return undefined;

  const [, monthToken, dayToken, hourToken, minuteToken, meridiemToken, zoneToken] = match;
  if (minuteToken === undefined && meridiemToken === undefined) return undefined;

  let hour = Number(hourToken);
  const minute = minuteToken === undefined ? 0 : Number(minuteToken);
  const meridiem = meridiemToken?.toLowerCase();
  if (meridiem !== undefined) {
    if (hour < 1 || hour > 12) return undefined;
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined;

  const timeZone = zoneToken ?? hostTimeZone;
  const today = zonedCalendarDate(now, timeZone);
  if (!today) return undefined;

  let resetAt: number | undefined;
  if (monthToken !== undefined) {
    const month = MONTHS[monthToken.toLowerCase().slice(0, 3)];
    const day = Number(dayToken);
    if (month === undefined || day < 1 || day > 31) return undefined;
    resetAt = zonedWallTimeToEpochMs({ year: today.year, month, day, hour, minute }, timeZone);
    if (resetAt !== undefined && resetAt < now - PAST_RESET_GRACE_MS) {
      resetAt = zonedWallTimeToEpochMs({ year: today.year + 1, month, day, hour, minute }, timeZone);
    }
  } else {
    resetAt = zonedWallTimeToEpochMs({ ...today, hour, minute }, timeZone);
    if (resetAt !== undefined && resetAt < now - PAST_RESET_GRACE_MS) {
      const tomorrow = addCalendarDays(today, 1);
      resetAt = zonedWallTimeToEpochMs({ ...tomorrow, hour, minute }, timeZone);
    }
  }

  if (resetAt === undefined) return undefined;
  if (resetAt < now - PAST_RESET_GRACE_MS || resetAt > now + MAX_RESET_HORIZON_MS) return undefined;
  return resetAt;
}

interface CalendarDate {
  year: number;
  /** 0-based month. */
  month: number;
  day: number;
}

function resolveHostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function zonedParts(epochMs: number, timeZone: string): Record<string, number> | undefined {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    // no-cause: an unknown IANA zone in the provider notice only means "no reset evidence"; the caller falls back to the 1 h re-check.
    return undefined;
  }
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(epochMs))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return parts;
}

function zonedCalendarDate(epochMs: number, timeZone: string): CalendarDate | undefined {
  const parts = zonedParts(epochMs, timeZone);
  if (!parts) return undefined;
  return { year: parts.year, month: parts.month - 1, day: parts.day };
}

/** Offset of `timeZone` from UTC at `epochMs`, in milliseconds (east positive). */
function zoneOffsetMs(epochMs: number, timeZone: string): number | undefined {
  const parts = zonedParts(epochMs, timeZone);
  if (!parts) return undefined;
  const wallAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
  return wallAsUtc - Math.floor(epochMs / 1000) * 1000;
}

function zonedWallTimeToEpochMs(
  wall: CalendarDate & { hour: number; minute: number },
  timeZone: string,
): number | undefined {
  const wallAsUtc = Date.UTC(wall.year, wall.month, wall.day, wall.hour, wall.minute);
  const firstOffset = zoneOffsetMs(wallAsUtc, timeZone);
  if (firstOffset === undefined) return undefined;
  const candidate = wallAsUtc - firstOffset;
  // A DST change between the guess and the real instant shifts the offset once.
  const secondOffset = zoneOffsetMs(candidate, timeZone);
  if (secondOffset === undefined) return undefined;
  return secondOffset === firstOffset ? candidate : wallAsUtc - secondOffset;
}

function addCalendarDays(date: CalendarDate, days: number): CalendarDate {
  const shifted = new Date(Date.UTC(date.year, date.month, date.day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth(), day: shifted.getUTCDate() };
}
