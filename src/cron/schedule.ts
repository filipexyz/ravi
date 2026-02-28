/**
 * Cron Schedule Utilities
 *
 * Functions for parsing schedule input and calculating next run times.
 */

import { Cron } from "croner";
import type { CronSchedule } from "./types.js";

/**
 * Calculate the next run time for a schedule.
 *
 * @param schedule - The schedule configuration
 * @param fromTime - Calculate from this time (default: now)
 * @returns Epoch ms of next run, or undefined if no more runs
 */
export function calculateNextRun(schedule: CronSchedule, fromTime = Date.now()): number | undefined {
  switch (schedule.type) {
    case "at":
      // One-shot: return the scheduled time if in future, undefined otherwise
      if (schedule.at && schedule.at > fromTime) {
        return schedule.at;
      }
      return undefined;

    case "every":
      // Interval: next run is fromTime + interval
      if (schedule.every) {
        return fromTime + schedule.every;
      }
      return undefined;

    case "cron":
      // Cron expression: use croner to calculate next occurrence
      if (schedule.cron) {
        try {
          const cron = new Cron(schedule.cron, {
            timezone: schedule.timezone,
          });
          const next = cron.nextRun(new Date(fromTime));
          return next ? next.getTime() : undefined;
        } catch {
          return undefined;
        }
      }
      return undefined;

    default:
      return undefined;
  }
}

/**
 * Validate a cron expression.
 *
 * @param expr - Cron expression to validate
 * @returns true if valid
 */
export function isValidCronExpression(expr: string): boolean {
  try {
    new Cron(expr);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse duration string to milliseconds.
 * Supports: 30s, 5m, 1h, 2d
 *
 * @example
 * parseDurationMs("30s") // 30000
 * parseDurationMs("5m")  // 300000
 * parseDurationMs("1h")  // 3600000
 * parseDurationMs("2d")  // 172800000
 */
export function parseDurationMs(duration: string): number {
  const match = duration.match(/^(\d+)(s|m|h|d)$/);
  if (!match) {
    throw new Error(`Invalid duration format: ${duration}. Use: 30s, 5m, 1h, 2d`);
  }

  const value = parseInt(match[1], 10);
  if (value <= 0) {
    throw new Error(`Duration must be positive: ${duration}`);
  }

  const unit = match[2];

  switch (unit) {
    case "s":
      return value * 1000;
    case "m":
      return value * 60 * 1000;
    case "h":
      return value * 60 * 60 * 1000;
    case "d":
      return value * 24 * 60 * 60 * 1000;
    default:
      throw new Error(`Unknown duration unit: ${unit}`);
  }
}

/**
 * Format milliseconds to human-readable duration.
 */
export function formatDurationMs(ms: number): string {
  if (ms < 60000) {
    return `${Math.round(ms / 1000)}s`;
  }
  if (ms < 3600000) {
    return `${Math.round(ms / 60000)}m`;
  }
  if (ms < 86400000) {
    return `${Math.round(ms / 3600000)}h`;
  }
  return `${Math.round(ms / 86400000)}d`;
}

/**
 * Parse an ISO date/time string to epoch ms.
 * Supports formats like:
 * - "2025-02-01T15:00"
 * - "2025-02-01T15:00:00"
 * - "2025-02-01T15:00:00Z"
 * - "2025-02-01T15:00:00-03:00"
 */
export function parseDateTime(dateTime: string): number {
  const date = new Date(dateTime);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date/time format: ${dateTime}`);
  }
  return date.getTime();
}

/**
 * Parse CLI schedule input to CronSchedule.
 *
 * Detects the schedule type based on input format:
 * - Duration (30m, 1h): interval schedule
 * - ISO date (2025-02-01T15:00): one-shot schedule
 * - Cron expression (0 9 * * *): cron schedule
 *
 * @param input - Raw schedule input from CLI
 * @param timezone - Optional timezone for cron schedules
 * @returns Parsed CronSchedule
 */
export function parseScheduleInput(input: string, timezone?: string): CronSchedule {
  // Check if it's a duration (interval)
  if (/^\d+(s|m|h|d)$/.test(input)) {
    return {
      type: "every",
      every: parseDurationMs(input),
    };
  }

  // Check if it's an ISO date/time (one-shot)
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(input)) {
    return {
      type: "at",
      at: parseDateTime(input),
    };
  }

  // Assume it's a cron expression
  if (!isValidCronExpression(input)) {
    throw new Error(
      `Invalid schedule: ${input}. Expected duration (30m), date (2025-02-01T15:00), or cron (0 9 * * *)`,
    );
  }

  return {
    type: "cron",
    cron: input,
    timezone,
  };
}

/**
 * Get a human-readable description of a schedule.
 */
export function describeSchedule(schedule: CronSchedule): string {
  switch (schedule.type) {
    case "at":
      return schedule.at ? `once at ${new Date(schedule.at).toLocaleString()}` : "one-shot (no time set)";
    case "every":
      return schedule.every ? `every ${formatDurationMs(schedule.every)}` : "interval (no duration set)";
    case "cron":
      return schedule.cron
        ? `cron: ${schedule.cron}${schedule.timezone ? ` (${schedule.timezone})` : ""}`
        : "cron (no expression set)";
    default:
      return "unknown schedule type";
  }
}
