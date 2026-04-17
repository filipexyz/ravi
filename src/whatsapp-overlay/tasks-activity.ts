import type { TaskStreamTaskEntity } from "../tasks/index.js";

const DEFAULT_DAYS = 84;
const LOCAL_DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface OverlayTasksDailyActivityBucket {
  date: string;
  count: number;
  doneCount: number;
  failedCount: number;
}

export interface OverlayTasksDailyActivitySummary {
  days: number;
  startDate: string;
  endDate: string;
  timeZone: string | null;
  totalCount: number;
  totalDoneCount: number;
  totalFailedCount: number;
  activeDays: number;
  maxDoneCount: number;
  currentStreak: number;
  bestDay: OverlayTasksDailyActivityBucket | null;
  buckets: OverlayTasksDailyActivityBucket[];
}

function padDatePart(value: number): string {
  return String(value).padStart(2, "0");
}

function normalizeLocalDateKey(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;

  const match = LOCAL_DATE_KEY_RE.exec(value.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(monthIndex) || !Number.isFinite(day)) {
    return null;
  }

  const date = new Date(Date.UTC(year, monthIndex, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== monthIndex || date.getUTCDate() !== day) {
    return null;
  }

  return `${year}-${padDatePart(monthIndex + 1)}-${padDatePart(day)}`;
}

function shiftLocalDateKey(value: string, days: number): string {
  const normalized = normalizeLocalDateKey(value);
  if (!normalized) {
    throw new Error(`invalid local date key: ${value}`);
  }

  const [, yearPart, monthPart, dayPart] = LOCAL_DATE_KEY_RE.exec(normalized) ?? [];
  const date = new Date(Date.UTC(Number(yearPart), Number(monthPart) - 1, Number(dayPart)));
  date.setUTCDate(date.getUTCDate() + days);
  return `${date.getUTCFullYear()}-${padDatePart(date.getUTCMonth() + 1)}-${padDatePart(date.getUTCDate())}`;
}

function createLocalDateFormatter(timeZone: string | null): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    ...(timeZone ? { timeZone } : {}),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function formatLocalDateKey(value: number, formatter: Intl.DateTimeFormat): string {
  const parts = formatter.formatToParts(new Date(value));
  const year = parts.find((part) => part.type === "year")?.value ?? "";
  const month = parts.find((part) => part.type === "month")?.value ?? "";
  const day = parts.find((part) => part.type === "day")?.value ?? "";
  return `${year}-${month}-${day}`;
}

function resolveTimeZone(value?: string | null): string | null {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (candidate) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(0);
      return candidate;
    } catch {
      // fall through to the process local timezone
    }
  }

  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export function buildOverlayTasksDailyActivity(input: {
  tasks: TaskStreamTaskEntity[];
  now?: number;
  days?: number;
  timeZone?: string | null;
  todayKey?: string | null;
}): OverlayTasksDailyActivitySummary {
  const days = Math.max(1, Math.floor(input.days ?? DEFAULT_DAYS));
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const timeZone = resolveTimeZone(input.timeZone);
  const formatter = createLocalDateFormatter(timeZone);
  const todayKey = normalizeLocalDateKey(input.todayKey) ?? formatLocalDateKey(now, formatter);
  const startDate = shiftLocalDateKey(todayKey, -(days - 1));
  const buckets: OverlayTasksDailyActivityBucket[] = [];
  const bucketByDate = new Map<string, OverlayTasksDailyActivityBucket>();

  for (let index = 0; index < days; index += 1) {
    const bucket: OverlayTasksDailyActivityBucket = {
      date: shiftLocalDateKey(startDate, index),
      count: 0,
      doneCount: 0,
      failedCount: 0,
    };
    buckets.push(bucket);
    bucketByDate.set(bucket.date, bucket);
  }

  for (const task of input.tasks ?? []) {
    const completedAt =
      typeof task?.completedAt === "number" && Number.isFinite(task.completedAt) ? task.completedAt : null;
    if (completedAt === null) {
      continue;
    }

    const bucket = bucketByDate.get(formatLocalDateKey(completedAt, formatter));
    if (!bucket) continue;

    bucket.count += 1;
    if (task.status === "done") {
      bucket.doneCount += 1;
    } else if (task.status === "failed") {
      bucket.failedCount += 1;
    }
  }

  const totalCount = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  const totalDoneCount = buckets.reduce((sum, bucket) => sum + bucket.doneCount, 0);
  const totalFailedCount = buckets.reduce((sum, bucket) => sum + bucket.failedCount, 0);
  const activeDays = buckets.reduce((sum, bucket) => sum + (bucket.doneCount > 0 ? 1 : 0), 0);
  const maxDoneCount = buckets.reduce((max, bucket) => Math.max(max, bucket.doneCount), 0);
  const bestDay =
    maxDoneCount > 0
      ? [...buckets].reduce<OverlayTasksDailyActivityBucket | null>((best, bucket) => {
          if (bucket.doneCount <= 0) return best;
          if (
            !best ||
            bucket.doneCount > best.doneCount ||
            (bucket.doneCount === best.doneCount && bucket.date > best.date)
          ) {
            return bucket;
          }
          return best;
        }, null)
      : null;

  let currentStreak = 0;
  for (let index = buckets.length - 1; index >= 0; index -= 1) {
    if (buckets[index]?.doneCount > 0) {
      currentStreak += 1;
      continue;
    }
    break;
  }

  return {
    days,
    startDate: buckets[0]?.date ?? startDate,
    endDate: buckets[buckets.length - 1]?.date ?? todayKey,
    timeZone,
    totalCount,
    totalDoneCount,
    totalFailedCount,
    activeDays,
    maxDoneCount,
    currentStreak,
    bestDay,
    buckets,
  };
}
