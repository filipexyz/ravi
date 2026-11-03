// Page Chat limits and price estimates. Pure functions only: the database
// lookups that feed them live in ./usage.ts.

export type PageChatLimits = {
  /** Longest single conversation, in seconds. */
  sessionMaxSeconds: number;
  /** Voice seconds one person may use per UTC day, across the organization. */
  viewerDailySeconds: number;
  /** Estimated spend the organization may reach per UTC month. */
  orgMonthlyBudgetUsd: number;
  /** Conversations the organization may hold open at once. */
  orgMaxConcurrentSessions: number;
};

export const PAGE_CHAT_DEFAULT_LIMITS: PageChatLimits = Object.freeze({
  sessionMaxSeconds: 600,
  viewerDailySeconds: 3600,
  orgMonthlyBudgetUsd: 50,
  orgMaxConcurrentSessions: 5,
});

/** Voice seconds one guest (someone outside the org) may use per UTC day, at most. */
export const PAGE_CHAT_GUEST_DAILY_SECONDS_CAP = 900;

/** A guest's limits: the organization's, with the daily cap lowered to at most 15 minutes. */
export function guestPageChatLimits(limits: PageChatLimits): PageChatLimits {
  return { ...limits, viewerDailySeconds: Math.min(limits.viewerDailySeconds, PAGE_CHAT_GUEST_DAILY_SECONDS_CAP) };
}

/** The voice provider bills this much up front when a session opens. */
export const PAGE_CHAT_MIN_SESSION_SECONDS = 15;

export const PAGE_CHAT_PRICE_VERSION = "2026-10-10";

export const VOICE_USD_PER_SECOND = 0.05 / 60;

type ModelPrice = {
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  outputUsdPerMillion: number;
};

// OpenAI list prices per 1M tokens, read from each model's page on 2026-10-10
// (PAGE_CHAT_PRICE_VERSION). A model missing here still runs, but its token
// cost is unknown and the estimate is marked incomplete instead of guessed.
const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = Object.freeze({
  "gpt-6-luna": { inputUsdPerMillion: 0.1, cachedInputUsdPerMillion: 0.01, outputUsdPerMillion: 0.5 },
  "gpt-5.6-luna": { inputUsdPerMillion: 0.2, cachedInputUsdPerMillion: 0.02, outputUsdPerMillion: 1.2 },
  "gpt-5.6-terra": { inputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.2, outputUsdPerMillion: 12 },
});

/** The background model Page Chat delegates reasoning and tool choice to. */
export const PAGE_CHAT_DEFAULT_BACKEND_MODEL = "gpt-6-luna";

/**
 * Reads limit overrides from the `console.pages.chat` entitlement value, e.g.
 * `{ "enabled": true, "limits": { "orgMonthlyBudgetUsd": 200 } }`. Anything
 * that is not a positive finite number keeps the default.
 */
export function parsePageChatLimits(valueJson: Record<string, unknown> | null | undefined): PageChatLimits {
  const raw = valueJson?.limits;
  const overrides = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const pick = (key: keyof PageChatLimits) => {
    const value = overrides[key];
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : PAGE_CHAT_DEFAULT_LIMITS[key];
  };
  return {
    sessionMaxSeconds: Math.floor(pick("sessionMaxSeconds")),
    viewerDailySeconds: Math.floor(pick("viewerDailySeconds")),
    orgMonthlyBudgetUsd: pick("orgMonthlyBudgetUsd"),
    orgMaxConcurrentSessions: Math.floor(pick("orgMaxConcurrentSessions")),
  };
}

export type PageChatCostInput = {
  voiceSeconds: number;
  model?: string | null;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
};

export type PageChatCostEstimate = {
  usd: number;
  voiceUsd: number;
  modelUsd: number;
  /** False when tokens were used by a model without a known price. */
  complete: boolean;
  priceVersion: string;
};

export function estimatePageChatCostUsd(input: PageChatCostInput): PageChatCostEstimate {
  const voiceUsd = nonNegative(input.voiceSeconds) * VOICE_USD_PER_SECOND;
  const inputTokens = nonNegative(input.inputTokens);
  const cachedInputTokens = nonNegative(input.cachedInputTokens);
  const outputTokens = nonNegative(input.outputTokens);
  const usedTokens = inputTokens + cachedInputTokens + outputTokens > 0;
  const price = input.model ? MODEL_PRICES[input.model] : undefined;

  const modelUsd = price
    ? (inputTokens * price.inputUsdPerMillion +
        cachedInputTokens * price.cachedInputUsdPerMillion +
        outputTokens * price.outputUsdPerMillion) /
      1_000_000
    : 0;

  return {
    usd: roundUsd(voiceUsd + modelUsd),
    voiceUsd: roundUsd(voiceUsd),
    modelUsd: roundUsd(modelUsd),
    complete: !usedTokens || Boolean(price),
    priceVersion: PAGE_CHAT_PRICE_VERSION,
  };
}

export type PageChatDenialReason =
  | "feature_unavailable"
  | "org_concurrency_limit"
  | "org_budget_exhausted"
  | "viewer_daily_limit";

export type PageChatAllowance =
  | { allowed: true; sessionMaxSeconds: number; limits: PageChatLimits }
  | { allowed: false; reason: PageChatDenialReason; limits: PageChatLimits };

/**
 * Decides whether a new conversation may start and how long it may run. The
 * budget bound counts voice time only, because token use cannot be known in
 * advance; the session enforces the rest while it runs.
 */
export function evaluatePageChatAllowance(input: {
  limits: PageChatLimits;
  orgMonthSpentUsd: number;
  viewerDaySeconds: number;
  openOrgSessions: number;
}): PageChatAllowance {
  const { limits } = input;
  if (input.openOrgSessions >= limits.orgMaxConcurrentSessions) {
    return { allowed: false, reason: "org_concurrency_limit", limits };
  }

  const budgetSeconds = Math.floor(
    Math.max(0, limits.orgMonthlyBudgetUsd - nonNegative(input.orgMonthSpentUsd)) / VOICE_USD_PER_SECOND,
  );
  if (budgetSeconds < PAGE_CHAT_MIN_SESSION_SECONDS) {
    return { allowed: false, reason: "org_budget_exhausted", limits };
  }

  const viewerSeconds = Math.floor(Math.max(0, limits.viewerDailySeconds - nonNegative(input.viewerDaySeconds)));
  if (viewerSeconds < PAGE_CHAT_MIN_SESSION_SECONDS) {
    return { allowed: false, reason: "viewer_daily_limit", limits };
  }

  return {
    allowed: true,
    sessionMaxSeconds: Math.min(limits.sessionMaxSeconds, budgetSeconds, viewerSeconds),
    limits,
  };
}

function nonNegative(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function roundUsd(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}
