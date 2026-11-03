// Five-field cron (minute hour day-of-month month day-of-week) evaluated in an
// IANA timezone, for Console-owned schedules (D8). Day of month and day of
// week follow Vixie cron: when both are restricted, either one matches.

export type CronSpec = {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  daysOfWeek: ReadonlySet<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
};

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
// Four years and a day reach every Feb 29 a valid expression can name.
const MAX_SCAN_DAYS = 366 * 4 + 1;

export class CronError extends Error {}

export function parseCron(expression: string): CronSpec {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new CronError("A cron expression has five fields: minute hour day-of-month month day-of-week.");
  const [minute = "", hour = "", dom = "", month = "", dow = ""] = fields;
  const daysOfWeek = parseField(dow, 0, 7, DAY_NAMES, "day of week");
  if (daysOfWeek.has(7)) {
    daysOfWeek.delete(7);
    daysOfWeek.add(0);
  }
  return {
    minutes: parseField(minute, 0, 59, null, "minute"),
    hours: parseField(hour, 0, 23, null, "hour"),
    daysOfMonth: parseField(dom, 1, 31, null, "day of month"),
    months: parseField(month, 1, 12, MONTH_NAMES, "month"),
    daysOfWeek,
    domRestricted: dom !== "*" && dom !== "?",
    dowRestricted: dow !== "*" && dow !== "?",
  };
}

export function isValidTimezone(timezone: string) {
  if (!timezone || timezone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The first instant strictly after `after` whose wall-clock time in
 * `timezone` matches. Wall times skipped by a DST jump do not fire; a wall
 * time repeated by a DST fall-back fires once, at its first occurrence.
 */
export function nextCronRun(expression: string | CronSpec, timezone: string, after: Date): Date | null {
  const spec = typeof expression === "string" ? parseCron(expression) : expression;
  const format = wallFormatter(timezone);
  const start = wallParts(format, after);
  const sortedHours = [...spec.hours].sort((a, b) => a - b);
  const sortedMinutes = [...spec.minutes].sort((a, b) => a - b);
  for (let offset = 0; offset < MAX_SCAN_DAYS; offset += 1) {
    const day = new Date(Date.UTC(start.year, start.month - 1, start.day + offset));
    const year = day.getUTCFullYear();
    const month = day.getUTCMonth() + 1;
    const date = day.getUTCDate();
    if (!spec.months.has(month) || !dayMatches(spec, date, day.getUTCDay())) continue;
    for (const hour of sortedHours) {
      for (const minute of sortedMinutes) {
        const instant = wallToInstant(format, year, month, date, hour, minute);
        if (!instant || instant.getTime() <= after.getTime()) continue;
        return instant;
      }
    }
  }
  return null;
}

function dayMatches(spec: CronSpec, date: number, weekday: number) {
  const dom = spec.daysOfMonth.has(date);
  const dow = spec.daysOfWeek.has(weekday);
  if (spec.domRestricted && spec.dowRestricted) return dom || dow;
  if (spec.domRestricted) return dom;
  if (spec.dowRestricted) return dow;
  return true;
}

function parseField(field: string, min: number, max: number, names: string[] | null, label: string) {
  const values = new Set<number>();
  if (!field) throw new CronError(`The ${label} field is empty.`);
  for (const part of field.split(",")) {
    const [rangePart = "", stepPart, ...rest] = part.split("/");
    if (rest.length > 0) throw new CronError(`Invalid ${label}: ${part}.`);
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1 || step > max) throw new CronError(`Invalid ${label} step: ${part}.`);
    let from: number;
    let to: number;
    if (rangePart === "*" || rangePart === "?") {
      from = min;
      to = max === 7 ? 6 : max;
    } else {
      const bounds = rangePart.split("-");
      if (bounds.length > 2) throw new CronError(`Invalid ${label}: ${part}.`);
      from = value(bounds[0] ?? "", min, max, names, label);
      to = bounds.length === 2 ? value(bounds[1] ?? "", min, max, names, label) : stepPart === undefined ? from : max;
      if (to < from) throw new CronError(`Invalid ${label} range: ${part}.`);
    }
    for (let current = from; current <= to; current += step) values.add(current);
  }
  return values;
}

function value(raw: string, min: number, max: number, names: string[] | null, label: string) {
  const named = names?.indexOf(raw.toLowerCase()) ?? -1;
  if (named >= 0) return names === MONTH_NAMES ? named + 1 : named;
  if (!/^\d{1,2}$/.test(raw)) throw new CronError(`Invalid ${label}: ${raw}.`);
  const number = Number(raw);
  if (number < min || number > max) throw new CronError(`The ${label} must be between ${min} and ${max}.`);
  return number;
}

type WallParts = { year: number; month: number; day: number; hour: number; minute: number };

function wallFormatter(timezone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
}

function wallParts(format: Intl.DateTimeFormat, instant: Date): WallParts & { second: number } {
  const parts = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const part of format.formatToParts(instant)) {
    if (part.type in parts) parts[part.type as keyof typeof parts] = Number(part.value);
  }
  return { ...parts, hour: parts.hour % 24 };
}

function offsetAt(format: Intl.DateTimeFormat, instant: number) {
  const wall = wallParts(format, new Date(instant));
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - Math.floor(instant / 1000) * 1000;
}

function wallToInstant(format: Intl.DateTimeFormat, year: number, month: number, day: number, hour: number, minute: number) {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  // Two offset passes settle on the offset in force at the wall time.
  const first = target - offsetAt(format, target);
  const candidates = [first, target - offsetAt(format, first)];
  let best: number | null = null;
  for (const candidate of candidates) {
    const wall = wallParts(format, new Date(candidate));
    if (wall.year === year && wall.month === month && wall.day === day && wall.hour === hour && wall.minute === minute) {
      if (best === null || candidate < best) best = candidate;
    }
  }
  if (best === null) return null;
  // Inside a repeated hour, the hour before may also show this wall time.
  const earlier = best - 3600_000;
  const earlierWall = wallParts(format, new Date(earlier));
  if (earlierWall.hour === hour && earlierWall.minute === minute && earlierWall.day === day) best = earlier;
  return new Date(best);
}
