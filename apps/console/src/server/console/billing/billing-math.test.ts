import { describe, expect, test } from "bun:test";

import {
  computeContractLines,
  contractCoversPeriod,
  currentPeriod,
  invoiceDueDate,
  isPeriod,
  lineAmountCents,
  periodWindow,
  shiftPeriod,
  sumCents,
} from "./billing-math";

describe("billing periods", () => {
  test("months are YYYY-MM", () => {
    expect(isPeriod("2026-10")).toBe(true);
    expect(isPeriod("2026-13")).toBe(false);
    expect(isPeriod("2026-1")).toBe(false);
    expect(shiftPeriod("2026-01", -1)).toBe("2025-12");
    expect(shiftPeriod("2026-12", 1)).toBe("2027-01");
  });

  test("the month follows São Paulo's clock", () => {
    // 02:59 UTC on Nov 1 is still Oct 31 in São Paulo.
    expect(currentPeriod(new Date("2026-11-01T02:59:00Z"))).toBe("2026-10");
    expect(currentPeriod(new Date("2026-11-01T03:00:00Z"))).toBe("2026-11");
    const window = periodWindow("2026-10");
    expect(window.start.toISOString()).toBe("2026-10-01T03:00:00.000Z");
    expect(window.end.toISOString()).toBe("2026-11-01T03:00:00.000Z");
  });

  test("a contract covers the months between its bounds", () => {
    expect(contractCoversPeriod({ startsPeriod: "2026-10", endsPeriod: null }, "2027-05")).toBe(true);
    expect(contractCoversPeriod({ startsPeriod: "2026-10", endsPeriod: null }, "2026-09")).toBe(false);
    expect(contractCoversPeriod({ startsPeriod: "2026-01", endsPeriod: "2026-09" }, "2026-09")).toBe(true);
    expect(contractCoversPeriod({ startsPeriod: "2026-01", endsPeriod: "2026-09" }, "2026-10")).toBe(false);
  });

  test("the invoice is due on the due day of the next month, or in three days when that passed", () => {
    expect(invoiceDueDate("2026-10", 10, new Date("2026-11-02T12:00:00Z"))).toBe("2026-11-10");
    expect(invoiceDueDate("2026-12", 5, new Date("2027-01-02T12:00:00Z"))).toBe("2027-01-05");
    expect(invoiceDueDate("2026-10", 10, new Date("2026-11-20T12:00:00Z"))).toBe("2026-11-23");
  });
});

describe("invoice lines", () => {
  test("amounts round to the cent without float noise", () => {
    expect(lineAmountCents(3, 10)).toBe(30);
    expect(lineAmountCents(0.1 * 3, 1000)).toBe(300);
    expect(lineAmountCents(1.5, 1)).toBe(2);
    expect(lineAmountCents(-1.5, 1)).toBe(-2);
    expect(sumCents([150_000, 2_550, -1_000])).toBe(151_550);
  });

  test("fixed lines bill the contract whatever runs; metered lines bill usage above what is included", () => {
    const lines = computeContractLines(
      [
        { id: "a", kind: "fixed", description: "Ravi installation", quantity: 3, unit: "installation", unitPriceCents: 50_000 },
        {
          id: "b",
          kind: "metered",
          description: "Call recording",
          metricKey: "meetings.recording_seconds",
          includedQuantity: 100,
          capQuantity: 200,
          unit: "minute",
          unitPriceCents: 50,
        },
        {
          id: "c",
          kind: "metered",
          description: "Page Chat",
          metricKey: "pages.chat.sessions",
          includedQuantity: 10,
          unit: "conversation",
          unitPriceCents: 100,
        },
      ],
      new Map([
        ["meetings.recording_seconds", 250],
        ["pages.chat.sessions", 4],
      ]),
    );
    expect(lines.map((line) => line.amountCents)).toEqual([150_000, 7_500, 0]);
    expect(lines[1]).toMatchObject({
      source: "contract_metered",
      quantity: 150,
      details: { used: 250, included: 100, cap: 200, overCap: true },
    });
    expect(lines[2]?.details.overCap).toBe(false);
  });
});
