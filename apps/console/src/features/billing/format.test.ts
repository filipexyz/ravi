import { describe, expect, test } from "bun:test";

import { centsToInput, formatPeriod, parseMoneyToCents, quantityLabel, shiftPeriod } from "./format";

describe("billing screen formats", () => {
  test("reads amounts typed the Brazilian or the plain way", () => {
    expect(parseMoneyToCents("1.500,00")).toBe(150_000);
    expect(parseMoneyToCents("R$ 1.500,5")).toBe(150_050);
    expect(parseMoneyToCents("1500.50")).toBe(150_050);
    expect(parseMoneyToCents("0,10")).toBe(10);
    expect(parseMoneyToCents("-200,00")).toBeNull();
    expect(parseMoneyToCents("-200,00", { allowNegative: true })).toBe(-20_000);
    expect(parseMoneyToCents("abc")).toBeNull();
    expect(parseMoneyToCents("1,234")).toBeNull();
    expect(centsToInput(150_050)).toBe("1500,50");
  });

  test("counts contract units and metric units", () => {
    expect(quantityLabel(2, null, "instalação")).toBe("2 × instalação");
    expect(quantityLabel(240, "meetings.recording_seconds", "minute")).toBe("240 minutes");
    expect(quantityLabel(1, "meetings.recording_seconds", "minute")).toBe("1 minute");
    expect(quantityLabel(3, "pages.requests.public", "thousand")).toBe("3 × 1,000 views");
  });

  test("names months", () => {
    expect(formatPeriod("2026-10")).toBe("Oct 2026");
    expect(shiftPeriod("2026-01", -1)).toBe("2025-12");
    expect(shiftPeriod("2026-12", 2)).toBe("2027-02");
  });
});
