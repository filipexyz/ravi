import { describe, expect, test } from "bun:test";

import {
  canFollowUp,
  describeCron,
  eventLine,
  formatBytes,
  formatSeconds,
  formatTokens,
  formatUsd,
  isActiveRun,
  parseBudgetInput,
  runDuration,
  runStatus,
} from "./format";

describe("cloud agents format", () => {
  test("run states read as words with a tone", () => {
    expect(runStatus("waiting_approval")).toMatchObject({ label: "Needs approval", tone: "warn" });
    expect(runStatus("budget_exceeded").label).toBe("Budget reached");
    expect(isActiveRun({ status: "starting" })).toBe(true);
    expect(isActiveRun({ status: "completed" })).toBe(false);
    expect(canFollowUp({ status: "completed" })).toBe(true);
    expect(canFollowUp({ status: "stopped" })).toBe(false);
  });

  test("money, time, tokens and sizes", () => {
    expect(formatUsd(5)).toBe("US$ 5.00");
    expect(formatUsd(0.0042)).toBe("US$ 0.0042");
    expect(formatSeconds(42)).toBe("42s");
    expect(formatSeconds(125)).toBe("2m 05s");
    expect(formatSeconds(3_900)).toBe("1h 05m");
    expect(runDuration({ startedAt: "2026-10-19T10:00:00Z", endedAt: "2026-10-19T10:01:30Z" })).toBe("1m 30s");
    expect(runDuration({ startedAt: "2026-10-19T10:00:00Z", endedAt: null }, Date.parse("2026-10-19T10:00:09Z"))).toBe("9s");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(1_234)).toBe("1.2k");
    expect(formatTokens(2_500_000)).toBe("2.5M");
    expect(formatBytes(2048)).toBe("2.0 KB");
  });

  test("budgets: empty is the agent's default, outside 0.50 to 200 is refused", () => {
    expect(parseBudgetInput("")).toEqual({ value: null, error: null });
    expect(parseBudgetInput("2,5")).toEqual({ value: 2.5, error: null });
    expect(parseBudgetInput("0.1").error).not.toBeNull();
    expect(parseBudgetInput("abc").error).not.toBeNull();
  });

  test("common crons read as sentences; others stay as typed", () => {
    expect(describeCron("0  9 * * 1-5")).toBe("Weekdays at 09:00");
    expect(describeCron("*/15 * * * *")).toBe("*/15 * * * *");
  });

  test("timeline lines for each event type", () => {
    expect(eventLine({ seq: 1, at: "", type: "message", role: "agent", text: "Hi" })).toEqual({ title: "Agent", body: "Hi", tone: "neutral" });
    expect(eventLine({ seq: 2, at: "", type: "message", role: "user", text: "Go" })?.title).toBe("You");
    expect(eventLine({ seq: 3, at: "", type: "tool_call", tool: "bash" })?.title).toBe("Used bash");
    expect(eventLine({ seq: 4, at: "", type: "approval", tool: "ravi_bases_rows_create", status: "denied" })).toMatchObject({
      title: "ravi_bases_rows_create was denied",
      tone: "err",
    });
    expect(eventLine({ seq: 5, at: "", type: "status", status: "waiting_approval" })?.title).toBe("Needs approval");
    expect(eventLine({ seq: 7, at: "", type: "status", status: "idle:end_turn" })?.title).toBe("Finished its turn");
    expect(eventLine({ seq: 8, at: "", type: "tool_result", status: "error", text: "boom" })).toMatchObject({ title: "The tool failed", tone: "warn" });
    expect(eventLine({ seq: 6, at: "", type: "status" })).toBeNull();
  });
});
