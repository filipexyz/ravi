// IANA timezone and calendar helpers for Bases. Intl only, no dependencies, so
// the server compiler and the Console UI agree on "today", weeks, and months.
// Date-only values are `YYYY-MM-DD` strings; weeks start on Monday.

import { BASE_DATE_ONLY_PATTERN, BASE_DURATION_PATTERN, BASE_INSTANT_PATTERN, BASES_LIMITS } from "./limits";
import type { BaseWithinValue } from "./types";

export type BaseDurationUnit = "d" | "w" | "mo" | "y";
export type BaseDuration = { n: number; unit: BaseDurationUnit };
export type BaseDateRange = { startDate: string; endDateExclusive: string };

const TIME_ZONE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,3}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

// Keyed by the canonical name Intl reports, so spellings that differ only in
// case share one entry and the cache stays bounded by the IANA zone list.
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function wallClockFormatter(timeZone: string) {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    era: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const canonical = formatter.resolvedOptions().timeZone;
  const existing = formatterCache.get(canonical);
  if (existing) return existing;
  formatterCache.set(canonical, formatter);
  return formatter;
}

/** True when `tz` is an IANA zone name (no raw offsets) known to Intl. */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  if (!TIME_ZONE_NAME_PATTERN.test(tz)) return false;
  try {
    wallClockFormatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** The canonical IANA name of a valid zone (`america/sao_paulo` -> `America/Sao_Paulo`), or null. */
export function canonicalTimeZone(tz: unknown): string | null {
  if (!isValidTimeZone(tz)) return null;
  return wallClockFormatter(tz).resolvedOptions().timeZone;
}

function assertTimeZone(tz: string) {
  if (!isValidTimeZone(tz)) throw new RangeError(`Invalid time zone: ${tz}`);
}

type WallClock = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function wallClock(instantMs: number, tz: string): WallClock {
  const parts = wallClockFormatter(tz).formatToParts(new Date(instantMs));
  const read = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const era = parts.find((part) => part.type === "era")?.value ?? "AD";
  const rawYear = read("year");
  return {
    year: era === "BC" || era === "B" ? 1 - rawYear : rawYear,
    month: read("month"),
    day: read("day"),
    hour: read("hour") % 24,
    minute: read("minute"),
    second: read("second"),
  };
}

function utcMs(year: number, month: number, day: number, hour = 0, minute = 0, second = 0) {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime();
}

/** Offset (local wall time minus UTC) in ms at the given instant. */
function offsetMs(instantMs: number, tz: string) {
  const wall = wallClock(instantMs, tz);
  const wallMs = utcMs(wall.year, wall.month, wall.day, wall.hour, wall.minute, wall.second);
  return wallMs - (instantMs - (((instantMs % 1000) + 1000) % 1000));
}

function pad(value: number, width: number) {
  const sign = value < 0 ? "-" : "";
  return sign + String(Math.abs(value)).padStart(width, "0");
}

function formatDateOnly(year: number, month: number, day: number) {
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

function parseDateOnly(dateOnly: string) {
  if (!BASE_DATE_ONLY_PATTERN.test(dateOnly)) throw new RangeError(`Invalid date: ${dateOnly}`);
  const year = Number(dateOnly.slice(0, 4));
  const month = Number(dateOnly.slice(5, 7));
  const day = Number(dateOnly.slice(8, 10));
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new RangeError(`Invalid date: ${dateOnly}`);
  }
  return { year, month, day };
}

function daysInMonth(year: number, month: number) {
  return new Date(utcMs(year, month + 1, 0)).getUTCDate();
}

function dateOnlyFromUtcMs(ms: number) {
  const date = new Date(ms);
  return formatDateOnly(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/** True when `value` is a real calendar date `YYYY-MM-DD` with year 0001..9999. */
export function isValidDateOnly(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const { year } = parseDateOnly(value);
    return year >= 1;
  } catch {
    return false;
  }
}

/**
 * Normalizes an ISO-8601 instant with an explicit offset (`Z` or `±HH:MM`) to
 * `Date.prototype.toISOString()` form; null when invalid or outside 0001..9999.
 */
export function normalizeBaseInstant(value: unknown): string | null {
  if (typeof value !== "string" || !BASE_INSTANT_PATTERN.test(value)) return null;
  if (!isValidDateOnly(value.slice(0, 10))) return null;
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  const second = value.length > 17 && value[16] === ":" ? Number(value.slice(17, 19)) : 0;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const offset = /([+-])(\d{2}):(\d{2})$/.exec(value);
  if (offset && (Number(offset[2]) > 23 || Number(offset[3]) > 59)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const normalized = new Date(ms).toISOString();
  return /^\d{4}-/.test(normalized) && !normalized.startsWith("0000") ? normalized : null;
}

/** Local calendar date (`YYYY-MM-DD`) of an instant in `tz`. */
export function localDateString(instant: Date, tz: string): string {
  assertTimeZone(tz);
  const wall = wallClock(instant.getTime(), tz);
  return formatDateOnly(wall.year, wall.month, wall.day);
}

/**
 * UTC instant at which the local day `dateOnly` starts in `tz`. When local
 * midnight does not exist (DST gap), this is the first instant of that day;
 * when it occurs twice, the earlier one.
 */
export function zonedMidnightUtc(dateOnly: string, tz: string): Date {
  assertTimeZone(tz);
  const { year, month, day } = parseDateOnly(dateOnly);
  const wallMs = utcMs(year, month, day);
  const offsetBefore = offsetMs(wallMs - DAY_MS, tz);
  const offsetAfter = offsetMs(wallMs + DAY_MS, tz);
  const candidates = [...new Set([wallMs - offsetBefore, wallMs - offsetAfter])].sort((a, b) => a - b);
  for (const candidate of candidates) {
    if (candidate - wallMs + offsetMs(candidate, tz) === 0) return new Date(candidate);
  }
  // Gap: the wall clock jumps over midnight. The day starts at the transition,
  // which is midnight read with the offset in force before it.
  return new Date(wallMs - offsetBefore);
}

/** Adds `n` days, weeks, months, or years to a date-only value; months and years clamp to the month end. */
export function addToDateOnly(dateOnly: string, n: number, unit: BaseDurationUnit): string {
  if (!Number.isInteger(n)) throw new RangeError(`Invalid amount: ${n}`);
  const { year, month, day } = parseDateOnly(dateOnly);
  if (unit === "d" || unit === "w") {
    return dateOnlyFromUtcMs(utcMs(year, month, day + (unit === "w" ? 7 * n : n)));
  }
  const totalMonths = year * 12 + (month - 1) + (unit === "y" ? 12 * n : n);
  const nextYear = Math.floor(totalMonths / 12);
  const nextMonth = totalMonths - nextYear * 12 + 1;
  return formatDateOnly(nextYear, nextMonth, Math.min(day, daysInMonth(nextYear, nextMonth)));
}

/** Monday of the week containing `dateOnly`. */
export function startOfWeekDateOnly(dateOnly: string): string {
  const { year, month, day } = parseDateOnly(dateOnly);
  const weekday = (new Date(utcMs(year, month, day)).getUTCDay() + 6) % 7;
  return addToDateOnly(dateOnly, -weekday, "d");
}

/** First day of the month containing `dateOnly`. */
export function startOfMonthDateOnly(dateOnly: string): string {
  const { year, month } = parseDateOnly(dateOnly);
  return formatDateOnly(year, month, 1);
}

/** First day of the calendar quarter containing `dateOnly`. */
export function startOfQuarterDateOnly(dateOnly: string): string {
  const { year, month } = parseDateOnly(dateOnly);
  return formatDateOnly(year, Math.floor((month - 1) / 3) * 3 + 1, 1);
}

/** January 1st of the year containing `dateOnly`. */
export function startOfYearDateOnly(dateOnly: string): string {
  const { year } = parseDateOnly(dateOnly);
  return formatDateOnly(year, 1, 1);
}

/** Parses `Nd`, `Nw`, `Nmo`, `Ny` with 1 <= N <= 1000; null when invalid. */
export function parseBaseDuration(value: unknown): BaseDuration | null {
  if (typeof value !== "string") return null;
  const match = BASE_DURATION_PATTERN.exec(value);
  if (!match) return null;
  const n = Number(match[1]);
  if (n < 1 || n > BASES_LIMITS.durationMax) return null;
  return { n, unit: match[2] as BaseDurationUnit };
}

/** True when `value` is a valid `within` operand. */
export function isBaseWithinValue(value: unknown): value is BaseWithinValue {
  if (value === "today" || value === "this_week" || value === "this_month" || value === "this_year") return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1) return false;
  const record = value as Record<string, unknown>;
  if (keys[0] === "past") return parseBaseDuration(record.past) !== null;
  if (keys[0] === "next") return parseBaseDuration(record.next) !== null;
  return false;
}

/**
 * Half-open local date range `[startDate, endDateExclusive)` for a `within`
 * operand: past N = [today - N, today + 1d), next N = [today, today + N + 1d).
 */
export function baseWithinRange(value: BaseWithinValue, now: Date, tz: string): BaseDateRange {
  const today = localDateString(now, tz);
  if (value === "today") return { startDate: today, endDateExclusive: addToDateOnly(today, 1, "d") };
  if (value === "this_week") {
    const monday = startOfWeekDateOnly(today);
    return { startDate: monday, endDateExclusive: addToDateOnly(monday, 7, "d") };
  }
  if (value === "this_month") {
    const first = startOfMonthDateOnly(today);
    return { startDate: first, endDateExclusive: addToDateOnly(first, 1, "mo") };
  }
  if (value === "this_year") {
    const first = startOfYearDateOnly(today);
    return { startDate: first, endDateExclusive: addToDateOnly(first, 1, "y") };
  }
  if (value && typeof value === "object" && "past" in value) {
    const duration = parseBaseDuration(value.past);
    if (!duration) throw new RangeError(`Invalid duration: ${String(value.past)}`);
    return {
      startDate: addToDateOnly(today, -duration.n, duration.unit),
      endDateExclusive: addToDateOnly(today, 1, "d"),
    };
  }
  if (value && typeof value === "object" && "next" in value) {
    const duration = parseBaseDuration(value.next);
    if (!duration) throw new RangeError(`Invalid duration: ${String(value.next)}`);
    return {
      startDate: today,
      endDateExclusive: addToDateOnly(addToDateOnly(today, duration.n, duration.unit), 1, "d"),
    };
  }
  throw new RangeError("Invalid within value.");
}
