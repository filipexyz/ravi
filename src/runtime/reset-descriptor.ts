export const RUNTIME_LIMIT_RESET_GRACE_MS = 60_000;

export function firstNonEmptyRuntimeLimitLine(value: string): string {
  return (
    value
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

export function normalizeRuntimeLimitText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

export function extractRuntimeLimitResetDescriptor(error: string): string | undefined {
  const firstLine = firstNonEmptyRuntimeLimitLine(error);
  const match = firstLine.match(/\breset(?:s|ting)?\s+(.+?)(?:$|[.;])/i);
  const raw = match?.[1]?.trim();
  if (!raw) return undefined;
  return normalizeRuntimeLimitText(raw.replace(/^at\s+/i, "")).slice(0, 120);
}

export function parseRuntimeLimitResetAt(
  error: string | undefined,
  now = Date.now(),
  graceMs = RUNTIME_LIMIT_RESET_GRACE_MS,
): number | undefined {
  if (!error) return undefined;
  const descriptor = extractRuntimeLimitResetDescriptor(error);
  return descriptor ? parseRuntimeLimitResetDescriptorTime(descriptor, now, graceMs) : undefined;
}

export function parseRuntimeLimitResetDescriptorTime(
  descriptor: string,
  now: number,
  graceMs = RUNTIME_LIMIT_RESET_GRACE_MS,
): number | undefined {
  return parseAbsoluteResetDescriptor(descriptor, now, graceMs) ?? parseClockResetDescriptor(descriptor, now, graceMs);
}

function parseAbsoluteResetDescriptor(descriptor: string, now: number, graceMs: number): number | undefined {
  const match = descriptor.match(
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,\s*(\d{4}))?(?:,?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/i,
  );
  if (!match) {
    return undefined;
  }

  const month = monthIndex(match[1]);
  const day = Number(match[2]);
  const explicitYear = match[3] ? Number(match[3]) : undefined;
  let hour = match[4] ? Number(match[4]) : 0;
  const minute = match[5] ? Number(match[5]) : 0;
  const meridiem = match[6]?.toLowerCase();
  if (
    month === undefined ||
    !Number.isInteger(day) ||
    day < 1 ||
    day > 31 ||
    !Number.isInteger(hour) ||
    hour < 0 ||
    hour > 23 ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59
  ) {
    return undefined;
  }
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;

  const currentYear = new Date(now).getUTCFullYear();
  const parsed = Date.UTC(explicitYear ?? currentYear, month, day, hour, minute);
  if (!Number.isFinite(parsed)) return undefined;
  if (explicitYear !== undefined || parsed > now - graceMs) return parsed;

  return Date.UTC(currentYear + 1, month, day, hour, minute);
}

function parseClockResetDescriptor(descriptor: string, now: number, graceMs: number): number | undefined {
  const match = descriptor.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (!match) return undefined;

  let hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  const meridiem = match[3]?.toLowerCase();
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    return undefined;
  }

  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;

  const resetAt = new Date(now);
  resetAt.setUTCHours(hour, minute, 0, 0);
  if (resetAt.getTime() <= now - graceMs) {
    resetAt.setUTCDate(resetAt.getUTCDate() + 1);
  }
  return resetAt.getTime();
}

function monthIndex(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const normalized = value.slice(0, 3).toLowerCase();
  return ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(normalized);
}
