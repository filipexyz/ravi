import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { dbGetCostPricingCoverage, dbInsertCostEvent, dbListCostEventsForPricingRecompute } from "./router-db.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-router-costs-test-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("cost event pricing recompute", () => {
  it("includes priced rows without pricing source metadata as legacy rows", () => {
    const now = Date.now();
    dbInsertCostEvent({
      sessionKey: "session-a",
      agentId: "agent-a",
      model: "opus",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      inputCostUsd: 0,
      outputCostUsd: 0,
      cacheCostUsd: 0,
      totalCostUsd: 0,
      pricingStatus: "priced",
      createdAt: now,
    });
    dbInsertCostEvent({
      sessionKey: "session-a",
      agentId: "agent-a",
      model: "claude-haiku-4-5",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      inputCostUsd: 0.00001,
      outputCostUsd: 0.000025,
      cacheCostUsd: 0,
      totalCostUsd: 0.000035,
      pricingStatus: "priced",
      pricingSource: "litellm:model_prices_and_context_window",
      pricingModel: "claude-haiku-4-5",
      createdAt: now + 1,
    });

    const coverage = dbGetCostPricingCoverage(now - 1);
    expect(coverage.find((row) => row.model === "opus")?.pricing_status).toBe("legacy");

    const rows = dbListCostEventsForPricingRecompute({ sinceMs: now - 1, limit: 10 });
    expect(rows.map((row) => row.model)).toEqual(["opus"]);
  });
});
