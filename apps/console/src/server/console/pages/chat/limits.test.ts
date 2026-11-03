import { describe, expect, test } from "bun:test";

import {
  estimatePageChatCostUsd,
  evaluatePageChatAllowance,
  guestPageChatLimits,
  PAGE_CHAT_DEFAULT_BACKEND_MODEL,
  PAGE_CHAT_DEFAULT_LIMITS,
  PAGE_CHAT_GUEST_DAILY_SECONDS_CAP,
  parsePageChatLimits,
} from "./limits";

describe("Page Chat limits", () => {
  test("uses the defaults and accepts positive overrides from the entitlement", () => {
    expect(parsePageChatLimits(null)).toEqual(PAGE_CHAT_DEFAULT_LIMITS);
    expect(
      parsePageChatLimits({
        enabled: true,
        limits: { orgMonthlyBudgetUsd: 200, sessionMaxSeconds: 0, viewerDailySeconds: "9999", orgMaxConcurrentSessions: 12.7 },
      }),
    ).toEqual({
      sessionMaxSeconds: 600,
      viewerDailySeconds: 3600,
      orgMonthlyBudgetUsd: 200,
      orgMaxConcurrentSessions: 12,
    });
  });

  test("prices voice per second and flags tokens from a model without a price", () => {
    expect(estimatePageChatCostUsd({ voiceSeconds: 300 })).toMatchObject({ usd: 0.25, complete: true });
    expect(estimatePageChatCostUsd({ voiceSeconds: 60, model: "unpriced", inputTokens: 1000 })).toMatchObject({
      usd: 0.05,
      modelUsd: 0,
      complete: false,
    });
  });

  test("prices the default background model's tokens", () => {
    // 1M input at 0.10, 1M cached at 0.01, 1M output at 0.50, plus 60 s of voice.
    expect(
      estimatePageChatCostUsd({
        voiceSeconds: 60,
        model: PAGE_CHAT_DEFAULT_BACKEND_MODEL,
        inputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    ).toMatchObject({ usd: 0.66, modelUsd: 0.61, voiceUsd: 0.05, complete: true });
  });

  test("caps the session by the remaining viewer day and organization budget", () => {
    const limits = PAGE_CHAT_DEFAULT_LIMITS;
    expect(evaluatePageChatAllowance({ limits, orgMonthSpentUsd: 0, viewerDaySeconds: 0, openOrgSessions: 0 })).toMatchObject({
      allowed: true,
      sessionMaxSeconds: 600,
    });
    expect(evaluatePageChatAllowance({ limits, orgMonthSpentUsd: 0, viewerDaySeconds: 3400, openOrgSessions: 0 })).toMatchObject({
      allowed: true,
      sessionMaxSeconds: 200,
    });
    // US$ 0.10 left buys 120 seconds of voice.
    expect(evaluatePageChatAllowance({ limits, orgMonthSpentUsd: 49.9, viewerDaySeconds: 0, openOrgSessions: 0 })).toMatchObject({
      allowed: true,
      sessionMaxSeconds: 120,
    });
  });

  test("denies when a limit leaves less than the provider's minimum billed session", () => {
    const limits = PAGE_CHAT_DEFAULT_LIMITS;
    expect(evaluatePageChatAllowance({ limits, orgMonthSpentUsd: 0, viewerDaySeconds: 0, openOrgSessions: 5 })).toMatchObject({
      allowed: false,
      reason: "org_concurrency_limit",
    });
    expect(evaluatePageChatAllowance({ limits, orgMonthSpentUsd: 49.995, viewerDaySeconds: 0, openOrgSessions: 0 })).toMatchObject({
      allowed: false,
      reason: "org_budget_exhausted",
    });
    expect(evaluatePageChatAllowance({ limits, orgMonthSpentUsd: 0, viewerDaySeconds: 3590, openOrgSessions: 0 })).toMatchObject({
      allowed: false,
      reason: "viewer_daily_limit",
    });
  });

  test("caps a guest's day at 15 minutes and never raises a lower org cap", () => {
    expect(PAGE_CHAT_GUEST_DAILY_SECONDS_CAP).toBe(900);
    expect(guestPageChatLimits(PAGE_CHAT_DEFAULT_LIMITS)).toEqual({ ...PAGE_CHAT_DEFAULT_LIMITS, viewerDailySeconds: 900 });
    expect(guestPageChatLimits({ ...PAGE_CHAT_DEFAULT_LIMITS, viewerDailySeconds: 300 }).viewerDailySeconds).toBe(300);
  });
});
