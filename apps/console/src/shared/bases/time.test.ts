import { describe, expect, test } from "bun:test";

import {
  addToDateOnly,
  baseWithinRange,
  isBaseWithinValue,
  isValidDateOnly,
  canonicalTimeZone,
  isValidTimeZone,
  localDateString,
  parseBaseDuration,
  startOfMonthDateOnly,
  startOfQuarterDateOnly,
  startOfWeekDateOnly,
  startOfYearDateOnly,
  zonedMidnightUtc,
} from "./time";

const iso = (date: Date) => date.toISOString();

describe("isValidTimeZone", () => {
  test("accepts IANA names", () => {
    for (const tz of ["UTC", "Etc/UTC", "America/Sao_Paulo", "America/New_York", "Europe/Berlin", "Asia/Kolkata", "America/Argentina/Buenos_Aires", "Etc/GMT+3"]) {
      expect(isValidTimeZone(tz)).toBe(true);
    }
  });

  test("rejects offsets, unknown names, and junk", () => {
    for (const tz of ["+03:00", "-0300", "Foo/Bar", "", " UTC", "America/Sao Paulo", "UTC;DROP", 42, null]) {
      expect(isValidTimeZone(tz)).toBe(false);
    }
  });
});

describe("canonicalTimeZone", () => {
  test("returns one spelling per zone and null for invalid names", () => {
    expect(canonicalTimeZone("america/sao_paulo")).toBe("America/Sao_Paulo");
    expect(canonicalTimeZone("AMERICA/SAO_PAULO")).toBe("America/Sao_Paulo");
    expect(canonicalTimeZone("America/Sao_Paulo")).toBe("America/Sao_Paulo");
    expect(canonicalTimeZone("UTC")).toBe("UTC");
    expect(canonicalTimeZone("Foo/Bar")).toBeNull();
    expect(canonicalTimeZone("+03:00")).toBeNull();
  });
});

describe("isValidDateOnly", () => {
  test("validates calendar dates", () => {
    expect(isValidDateOnly("2026-10-06")).toBe(true);
    expect(isValidDateOnly("2024-02-29")).toBe(true);
    expect(isValidDateOnly("2026-02-29")).toBe(false);
    expect(isValidDateOnly("2026-13-01")).toBe(false);
    expect(isValidDateOnly("2026-04-31")).toBe(false);
    expect(isValidDateOnly("0000-01-01")).toBe(false);
    expect(isValidDateOnly("2026-1-01")).toBe(false);
    expect(isValidDateOnly("2026-10-06T00:00:00Z")).toBe(false);
  });
});

describe("localDateString", () => {
  test("uses the zone's wall clock", () => {
    const instant = new Date("2026-10-06T02:00:00Z");
    expect(localDateString(instant, "UTC")).toBe("2026-10-06");
    expect(localDateString(instant, "America/Sao_Paulo")).toBe("2026-10-05");
    expect(localDateString(instant, "America/New_York")).toBe("2026-10-05");
    expect(localDateString(instant, "Europe/Berlin")).toBe("2026-10-06");
    expect(localDateString(instant, "Asia/Kolkata")).toBe("2026-10-06");
  });

  test("half-hour offsets switch days at :30", () => {
    expect(localDateString(new Date("2026-10-05T18:29:59.999Z"), "Asia/Kolkata")).toBe("2026-10-05");
    expect(localDateString(new Date("2026-10-05T18:30:00.000Z"), "Asia/Kolkata")).toBe("2026-10-06");
  });

  test("DST boundaries", () => {
    // New York falls back on 2026-11-01 at 06:00Z (02:00 EDT -> 01:00 EST).
    expect(localDateString(new Date("2026-11-01T03:59:59Z"), "America/New_York")).toBe("2026-10-31");
    expect(localDateString(new Date("2026-11-01T04:00:00Z"), "America/New_York")).toBe("2026-11-01");
    expect(localDateString(new Date("2026-11-02T04:59:59Z"), "America/New_York")).toBe("2026-11-01");
    expect(localDateString(new Date("2026-11-02T05:00:00Z"), "America/New_York")).toBe("2026-11-02");
  });

  test("small years are zero padded", () => {
    expect(localDateString(new Date("0099-01-05T12:00:00Z"), "UTC")).toBe("0099-01-05");
  });

  test("rejects invalid zones", () => {
    expect(() => localDateString(new Date(), "+03:00")).toThrow();
  });
});

describe("zonedMidnightUtc", () => {
  test("fixed offsets", () => {
    expect(iso(zonedMidnightUtc("2026-10-06", "UTC"))).toBe("2026-10-06T00:00:00.000Z");
    expect(iso(zonedMidnightUtc("2026-10-06", "America/Sao_Paulo"))).toBe("2026-10-06T03:00:00.000Z");
    expect(iso(zonedMidnightUtc("2026-10-06", "Asia/Kolkata"))).toBe("2026-10-05T18:30:00.000Z");
  });

  test("New York around both 2026 transitions", () => {
    expect(iso(zonedMidnightUtc("2026-03-08", "America/New_York"))).toBe("2026-03-08T05:00:00.000Z");
    expect(iso(zonedMidnightUtc("2026-03-09", "America/New_York"))).toBe("2026-03-09T04:00:00.000Z");
    expect(iso(zonedMidnightUtc("2026-11-01", "America/New_York"))).toBe("2026-11-01T04:00:00.000Z");
    expect(iso(zonedMidnightUtc("2026-11-02", "America/New_York"))).toBe("2026-11-02T05:00:00.000Z");
  });

  test("Berlin around both 2026 transitions", () => {
    expect(iso(zonedMidnightUtc("2026-03-29", "Europe/Berlin"))).toBe("2026-03-28T23:00:00.000Z");
    expect(iso(zonedMidnightUtc("2026-03-30", "Europe/Berlin"))).toBe("2026-03-29T22:00:00.000Z");
    expect(iso(zonedMidnightUtc("2026-10-25", "Europe/Berlin"))).toBe("2026-10-24T22:00:00.000Z");
    expect(iso(zonedMidnightUtc("2026-10-26", "Europe/Berlin"))).toBe("2026-10-25T23:00:00.000Z");
  });

  test("a day whose midnight does not exist starts at the transition", () => {
    // Sao Paulo jumped from 00:00 -03 to 01:00 -02 on 2018-11-04.
    const start = zonedMidnightUtc("2018-11-04", "America/Sao_Paulo");
    expect(iso(start)).toBe("2018-11-04T03:00:00.000Z");
    expect(localDateString(start, "America/Sao_Paulo")).toBe("2018-11-04");
    expect(localDateString(new Date(start.getTime() - 1), "America/Sao_Paulo")).toBe("2018-11-03");
  });

  test("a day after a fall-back at midnight", () => {
    // Sao Paulo went from 00:00 -02 back to 23:00 -03 on 2019-02-17.
    const start = zonedMidnightUtc("2019-02-17", "America/Sao_Paulo");
    expect(iso(start)).toBe("2019-02-17T03:00:00.000Z");
    expect(localDateString(new Date(start.getTime() - 1), "America/Sao_Paulo")).toBe("2019-02-16");
    expect(iso(zonedMidnightUtc("2019-02-16", "America/Sao_Paulo"))).toBe("2019-02-16T02:00:00.000Z");
  });

  test("local midnight round-trips through localDateString for every day of 2026", () => {
    for (const tz of ["America/Sao_Paulo", "America/New_York", "Europe/Berlin", "Asia/Kolkata", "UTC"]) {
      let day = "2026-01-01";
      while (day < "2027-01-01") {
        const start = zonedMidnightUtc(day, tz);
        expect(localDateString(start, tz)).toBe(day);
        expect(localDateString(new Date(start.getTime() - 1), tz)).toBe(addToDateOnly(day, -1, "d"));
        day = addToDateOnly(day, 1, "d");
      }
    }
  });

  test("rejects invalid input", () => {
    expect(() => zonedMidnightUtc("2026-02-30", "UTC")).toThrow();
    expect(() => zonedMidnightUtc("2026-10-06", "Mars/Olympus")).toThrow();
  });
});

describe("addToDateOnly", () => {
  test("days and weeks", () => {
    expect(addToDateOnly("2026-10-06", 1, "d")).toBe("2026-10-07");
    expect(addToDateOnly("2026-12-31", 1, "d")).toBe("2027-01-01");
    expect(addToDateOnly("2026-03-01", -1, "d")).toBe("2026-02-28");
    expect(addToDateOnly("2024-03-01", -1, "d")).toBe("2024-02-29");
    expect(addToDateOnly("2026-10-06", 2, "w")).toBe("2026-10-20");
    expect(addToDateOnly("2026-01-05", -1, "w")).toBe("2025-12-29");
  });

  test("months clamp to the month end", () => {
    expect(addToDateOnly("2026-01-31", 1, "mo")).toBe("2026-02-28");
    expect(addToDateOnly("2024-01-31", 1, "mo")).toBe("2024-02-29");
    expect(addToDateOnly("2026-03-31", -1, "mo")).toBe("2026-02-28");
    expect(addToDateOnly("2026-10-15", 3, "mo")).toBe("2027-01-15");
    expect(addToDateOnly("2026-01-15", -13, "mo")).toBe("2024-12-15");
  });

  test("years clamp Feb 29", () => {
    expect(addToDateOnly("2024-02-29", 1, "y")).toBe("2025-02-28");
    expect(addToDateOnly("2024-02-29", 4, "y")).toBe("2028-02-29");
    expect(addToDateOnly("2026-10-06", -1, "y")).toBe("2025-10-06");
  });

  test("small years do not jump to the 1900s", () => {
    expect(addToDateOnly("0050-01-01", 1, "d")).toBe("0050-01-02");
  });
});

describe("period starts", () => {
  test("weeks start on Monday", () => {
    expect(startOfWeekDateOnly("2026-10-05")).toBe("2026-10-05");
    expect(startOfWeekDateOnly("2026-10-06")).toBe("2026-10-05");
    expect(startOfWeekDateOnly("2026-10-11")).toBe("2026-10-05");
    expect(startOfWeekDateOnly("2026-10-12")).toBe("2026-10-12");
    expect(startOfWeekDateOnly("2027-01-01")).toBe("2026-12-28");
  });

  test("months, quarters, years", () => {
    expect(startOfMonthDateOnly("2026-10-06")).toBe("2026-10-01");
    expect(startOfQuarterDateOnly("2026-10-06")).toBe("2026-10-01");
    expect(startOfQuarterDateOnly("2026-09-30")).toBe("2026-07-01");
    expect(startOfQuarterDateOnly("2026-02-14")).toBe("2026-01-01");
    expect(startOfQuarterDateOnly("2026-05-01")).toBe("2026-04-01");
    expect(startOfYearDateOnly("2026-10-06")).toBe("2026-01-01");
  });
});

describe("parseBaseDuration", () => {
  test("accepts N in 1..1000", () => {
    expect(parseBaseDuration("7d")).toEqual({ n: 7, unit: "d" });
    expect(parseBaseDuration("2w")).toEqual({ n: 2, unit: "w" });
    expect(parseBaseDuration("3mo")).toEqual({ n: 3, unit: "mo" });
    expect(parseBaseDuration("1y")).toEqual({ n: 1, unit: "y" });
    expect(parseBaseDuration("1000d")).toEqual({ n: 1000, unit: "d" });
  });

  test("rejects everything else", () => {
    for (const value of ["0d", "1001d", "07d", "-1d", "1m", "1h", "d", "1.5d", " 1d", "1D", 7, null]) {
      expect(parseBaseDuration(value)).toBeNull();
    }
  });
});

describe("isBaseWithinValue", () => {
  test("keywords and durations", () => {
    expect(isBaseWithinValue("today")).toBe(true);
    expect(isBaseWithinValue("this_week")).toBe(true);
    expect(isBaseWithinValue({ past: "7d" })).toBe(true);
    expect(isBaseWithinValue({ next: "2w" })).toBe(true);
    expect(isBaseWithinValue("yesterday")).toBe(false);
    expect(isBaseWithinValue({ past: "7x" })).toBe(false);
    expect(isBaseWithinValue({ past: "7d", next: "1d" })).toBe(false);
    expect(isBaseWithinValue(["today"])).toBe(false);
  });
});

describe("baseWithinRange", () => {
  // Tuesday 2026-10-06 12:00 in Sao Paulo.
  const now = new Date("2026-10-06T15:00:00Z");

  test("keywords", () => {
    expect(baseWithinRange("today", now, "America/Sao_Paulo")).toEqual({ startDate: "2026-10-06", endDateExclusive: "2026-10-07" });
    expect(baseWithinRange("this_week", now, "America/Sao_Paulo")).toEqual({ startDate: "2026-10-05", endDateExclusive: "2026-10-12" });
    expect(baseWithinRange("this_month", now, "America/Sao_Paulo")).toEqual({ startDate: "2026-10-01", endDateExclusive: "2026-11-01" });
    expect(baseWithinRange("this_year", now, "America/Sao_Paulo")).toEqual({ startDate: "2026-01-01", endDateExclusive: "2027-01-01" });
  });

  test("past and next include today", () => {
    expect(baseWithinRange({ past: "7d" }, now, "UTC")).toEqual({ startDate: "2026-09-29", endDateExclusive: "2026-10-07" });
    expect(baseWithinRange({ next: "2w" }, now, "UTC")).toEqual({ startDate: "2026-10-06", endDateExclusive: "2026-10-21" });
    expect(baseWithinRange({ past: "1y" }, now, "UTC")).toEqual({ startDate: "2025-10-06", endDateExclusive: "2026-10-07" });
  });

  test("month durations clamp", () => {
    expect(baseWithinRange({ next: "1mo" }, new Date("2026-01-31T12:00:00Z"), "UTC")).toEqual({
      startDate: "2026-01-31",
      endDateExclusive: "2026-03-01",
    });
    expect(baseWithinRange({ past: "1mo" }, new Date("2026-03-31T12:00:00Z"), "UTC")).toEqual({
      startDate: "2026-02-28",
      endDateExclusive: "2026-04-01",
    });
  });

  test("today depends on the zone", () => {
    const lateUtc = new Date("2026-10-05T19:00:00Z");
    expect(baseWithinRange("today", lateUtc, "Asia/Kolkata").startDate).toBe("2026-10-06");
    expect(baseWithinRange("today", lateUtc, "UTC").startDate).toBe("2026-10-05");
    const earlyUtc = new Date("2026-10-06T02:00:00Z");
    expect(baseWithinRange("today", earlyUtc, "America/New_York").startDate).toBe("2026-10-05");
    expect(baseWithinRange("this_week", new Date("2026-10-05T02:00:00Z"), "America/Sao_Paulo")).toEqual({
      startDate: "2026-09-28",
      endDateExclusive: "2026-10-05",
    });
  });

  test("this_week across a DST change keeps calendar weeks", () => {
    const sunday = new Date("2026-11-01T16:00:00Z");
    expect(baseWithinRange("this_week", sunday, "America/New_York")).toEqual({
      startDate: "2026-10-26",
      endDateExclusive: "2026-11-02",
    });
    expect(baseWithinRange("this_week", new Date("2026-03-29T10:00:00Z"), "Europe/Berlin")).toEqual({
      startDate: "2026-03-23",
      endDateExclusive: "2026-03-30",
    });
  });

  test("rejects invalid durations", () => {
    expect(() => baseWithinRange({ past: "0d" }, now, "UTC")).toThrow();
  });
});
