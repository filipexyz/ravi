import { describe, expect, test } from "bun:test";

import { CronError, isValidTimezone, nextCronRun, parseCron } from "./cron";

describe("cloud agents cron", () => {
  test("parses fields, ranges, steps, lists and names", () => {
    const spec = parseCron("*/15 9-17 * jan,jul mon-fri");
    expect([...spec.minutes]).toEqual([0, 15, 30, 45]);
    expect(spec.hours.size).toBe(9);
    expect([...spec.months].sort((a, b) => a - b)).toEqual([1, 7]);
    expect([...spec.daysOfWeek].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(parseCron("0 0 * * 7").daysOfWeek.has(0)).toBe(true);
  });

  test("refuses malformed expressions", () => {
    for (const bad of ["* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "5-1 * * * *", "*/0 * * * *", "a * * * *"]) {
      expect(() => parseCron(bad)).toThrow(CronError);
    }
  });

  test("next run in UTC", () => {
    const next = nextCronRun("0 9 * * 1-5", "UTC", new Date("2026-10-16T09:00:00Z"));
    // Friday 09:00 has passed; next weekday is Monday.
    expect(next?.toISOString()).toBe("2026-10-19T09:00:00.000Z");
  });

  test("next run in a timezone", () => {
    const next = nextCronRun("0 9 * * *", "America/Sao_Paulo", new Date("2026-10-19T10:00:00Z"));
    expect(next?.toISOString()).toBe("2026-10-19T12:00:00.000Z");
  });

  test("a minute schedule fires strictly after the reference", () => {
    const next = nextCronRun("* * * * *", "UTC", new Date("2026-10-19T10:00:30Z"));
    expect(next?.toISOString()).toBe("2026-10-19T10:01:00.000Z");
  });

  test("a wall time skipped by DST does not fire that day", () => {
    // New York springs forward on 2027-03-14: 02:30 does not exist.
    const next = nextCronRun("30 2 * * *", "America/New_York", new Date("2027-03-13T12:00:00Z"));
    expect(next?.toISOString()).toBe("2027-03-15T06:30:00.000Z");
  });

  test("a repeated wall time fires once, at its first occurrence", () => {
    // New York falls back on 2026-11-01: 01:30 happens at 05:30Z and 06:30Z.
    const first = nextCronRun("30 1 * * *", "America/New_York", new Date("2026-11-01T00:00:00Z"));
    expect(first?.toISOString()).toBe("2026-11-01T05:30:00.000Z");
    const second = nextCronRun("30 1 * * *", "America/New_York", first as Date);
    expect(second?.toISOString()).toBe("2026-11-02T06:30:00.000Z");
  });

  test("day of month or day of week when both are set", () => {
    const next = nextCronRun("0 0 13 * 5", "UTC", new Date("2026-10-19T00:00:00Z"));
    // Friday 2026-10-23 comes before the 13th of November.
    expect(next?.toISOString()).toBe("2026-10-23T00:00:00.000Z");
  });

  test("Feb 29 is found", () => {
    expect(nextCronRun("0 0 29 2 *", "UTC", new Date("2026-10-19T00:00:00Z"))?.toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });

  test("timezones", () => {
    expect(isValidTimezone("America/Sao_Paulo")).toBe(true);
    expect(isValidTimezone("Mars/Base")).toBe(false);
  });
});
