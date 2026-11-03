import { describe, expect, test } from "bun:test";

import { usageMetricKeys } from "@/server/console/billing/usage-metering";

import {
  buildTextTurnUsageEvents,
  evaluateTextChatAllowance,
  TEXT_CHAT_DEFAULT_TURNS_PER_PERSON_DAY,
  TEXT_CHAT_GUEST_TURNS_PER_DAY,
} from "./usage";

const facts = { entitlementValueJson: null, orgMonthSpentUsd: 0, personTurnsToday: 0 };

describe("Page chat text allowance", () => {
  test("a member has the daily cap, a guest a smaller one", () => {
    expect(evaluateTextChatAllowance({ facts: { ...facts, personTurnsToday: TEXT_CHAT_DEFAULT_TURNS_PER_PERSON_DAY - 1 }, guest: false }).allowed).toBe(true);
    expect(evaluateTextChatAllowance({ facts: { ...facts, personTurnsToday: TEXT_CHAT_DEFAULT_TURNS_PER_PERSON_DAY }, guest: false })).toEqual({
      allowed: false,
      reason: "person_daily_limit",
    });
    expect(evaluateTextChatAllowance({ facts: { ...facts, personTurnsToday: TEXT_CHAT_GUEST_TURNS_PER_DAY }, guest: true }).allowed).toBe(false);
  });

  test("the org budget is shared with voice and stops everyone", () => {
    expect(evaluateTextChatAllowance({ facts: { ...facts, orgMonthSpentUsd: 1e9 }, guest: false })).toEqual({ allowed: false, reason: "org_budget_exhausted" });
  });

  test("an entitlement can change the daily cap", () => {
    const custom = { ...facts, entitlementValueJson: { limits: { textTurnsPerPersonDay: 3 } }, personTurnsToday: 3 };
    expect(evaluateTextChatAllowance({ facts: custom, guest: false }).allowed).toBe(false);
  });
});

describe("Page chat text usage events", () => {
  const report = {
    organizationId: "org",
    projectId: "project",
    siteId: "site",
    roomId: "room",
    turnId: "turn",
    speakerUserId: "user",
    model: "anthropic/claude-sonnet-5.5",
    inputTokens: 1200,
    cachedInputTokens: 0,
    outputTokens: 300,
    costUsd: 0.0123,
    toolCalls: 2,
    status: "complete" as const,
    finishedAt: new Date("2026-10-18T12:00:00Z"),
  };

  test("one turn row carries the cost; tokens and tools get their own rows; keys are idempotent per turn", () => {
    const events = buildTextTurnUsageEvents(report);
    const turn = events.find((event) => event.metricKey === usageMetricKeys.pagesChatTextTurns);
    expect(turn?.measurementsJson).toMatchObject({ estimatedCostUsd: 0.0123, estimatedCostComplete: true, toolCalls: 2 });
    expect(events.map((event) => event.metricKey)).not.toContain(usageMetricKeys.pagesChatModelCachedInputTokens);
    expect(events.some((event) => event.metricKey === usageMetricKeys.pagesChatToolCalls)).toBe(true);
    expect(new Set(events.map((event) => event.idempotencyKey)).size).toBe(events.length);
    expect(JSON.stringify(events.map((event) => event.metricKey))).not.toContain("claude");
  });

  test("a turn without a reported cost is recorded as incomplete", () => {
    const [turn] = buildTextTurnUsageEvents({ ...report, costUsd: null, toolCalls: 0 });
    expect(turn?.measurementsJson).toMatchObject({ estimatedCostUsd: null, estimatedCostComplete: false });
    expect(turn?.evidenceJson).toEqual({ costReported: false });
  });

  test("an explicitly reported zero is distinct from unknown cost", () => {
    const [turn] = buildTextTurnUsageEvents({ ...report, costUsd: 0 });
    expect(turn?.measurementsJson).toMatchObject({ estimatedCostUsd: 0, estimatedCostComplete: true });
    expect(turn?.evidenceJson).toEqual({ costReported: true });
  });
});
