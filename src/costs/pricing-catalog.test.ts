import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  calculateCost,
  loadPricingCatalog,
  pricingModelCandidates,
  resetPricingCatalogForTests,
  type PricingCatalogSnapshot,
} from "./pricing-catalog.js";

const now = 1_765_000_000_000;

function catalog(entries: PricingCatalogSnapshot["entries"]): PricingCatalogSnapshot {
  return {
    source: "test",
    sourceUrl: "https://example.test/prices.json",
    sourceVersion: "v1",
    fetchedAt: now,
    stale: false,
    entries,
  };
}

afterEach(() => {
  resetPricingCatalogForTests();
});

describe("pricing catalog", () => {
  it("calculates cost from LiteLLM pricing fields and normalizes Claude [1m] markers", async () => {
    const cost = await calculateCost(
      "claude-opus-4-7[1m]",
      { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheRead: 1_000_000, cacheCreation: 1_000_000 },
      {
        catalog: catalog({
          "claude-opus-4-7": {
            input_cost_per_token: 0.000005,
            output_cost_per_token: 0.000025,
            cache_read_input_token_cost: 0.0000005,
            cache_creation_input_token_cost: 0.00000625,
          },
        }),
      },
    );

    expect(cost.pricingStatus).toBe("priced");
    expect(cost.inputCost).toBe(5);
    expect(cost.outputCost).toBe(25);
    expect(cost.cacheCost).toBe(6.75);
    expect(cost.totalCost).toBe(36.75);
    expect(cost.pricing?.model).toBe("claude-opus-4-7");
  });

  it("normalizes OpenRouter-style Anthropic dotted model versions", async () => {
    const cost = await calculateCost(
      "anthropic/claude-opus-4.8",
      { inputTokens: 1_000_000, outputTokens: 0, cacheRead: 0, cacheCreation: 0 },
      {
        catalog: catalog({
          "claude-opus-4-8": {
            input_cost_per_token: 0.000005,
            output_cost_per_token: 0.000025,
          },
        }),
      },
    );

    expect(cost.pricingStatus).toBe("priced");
    expect(cost.inputCost).toBe(5);
    expect(cost.pricing?.model).toBe("claude-opus-4-8");
  });

  it("does not fall back to a generic Claude family price for unknown models", async () => {
    const cost = await calculateCost(
      "claude-opus-4-9",
      { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheRead: 0, cacheCreation: 0 },
      {
        catalog: catalog({
          "claude-opus-4-8": {
            input_cost_per_token: 0.000005,
            output_cost_per_token: 0.000025,
          },
        }),
      },
    );

    expect(cost.pricingStatus).toBe("unpriced");
    expect(cost.totalCost).toBe(0);
  });

  it("fetches and caches a remote catalog", async () => {
    const root = mkdtempSync(join(tmpdir(), "ravi-pricing-test-"));
    const cachePath = join(root, "pricing.json");
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          "claude-haiku-4-5": {
            input_cost_per_token: 0.000001,
            output_cost_per_token: 0.000005,
          },
        }),
        { headers: { etag: "test-etag" } },
      );

    try {
      const first = await loadPricingCatalog({
        cachePath,
        fetchImpl,
        now,
        env: { RAVI_PRICING_CATALOG_URL: "https://example.test/prices.json" },
      });
      expect(first?.sourceVersion).toBe("test-etag");

      resetPricingCatalogForTests();
      const second = await loadPricingCatalog({
        cachePath,
        fetchImpl: (async () => {
          throw new Error("network should not be used");
        }) as typeof fetchImpl,
        now: now + 1,
        env: { RAVI_PRICING_CATALOG_URL: "https://example.test/prices.json" },
      });
      expect(second?.entries["claude-haiku-4-5"]).toBeTruthy();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not share in-flight fetches across catalog sources", async () => {
    const root = mkdtempSync(join(tmpdir(), "ravi-pricing-test-"));
    const firstCachePath = join(root, "first.json");
    const secondCachePath = join(root, "second.json");

    try {
      const [first, second] = await Promise.all([
        loadPricingCatalog({
          cachePath: firstCachePath,
          fetchImpl: async () =>
            new Response(
              JSON.stringify({
                "claude-opus-4-7": {
                  input_cost_per_token: 0.000005,
                  output_cost_per_token: 0.000025,
                },
              }),
            ),
          now,
          env: { RAVI_PRICING_CATALOG_URL: "https://example.test/first.json" },
        }),
        loadPricingCatalog({
          cachePath: secondCachePath,
          fetchImpl: async () =>
            new Response(
              JSON.stringify({
                "claude-haiku-4-5": {
                  input_cost_per_token: 0.000001,
                  output_cost_per_token: 0.000005,
                },
              }),
            ),
          now,
          env: { RAVI_PRICING_CATALOG_URL: "https://example.test/second.json" },
        }),
      ]);

      expect(first?.entries["claude-opus-4-7"]).toBeTruthy();
      expect(first?.entries["claude-haiku-4-5"]).toBeUndefined();
      expect(second?.entries["claude-haiku-4-5"]).toBeTruthy();
      expect(second?.entries["claude-opus-4-7"]).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("builds exact-match candidates without family fallback keys", () => {
    expect(pricingModelCandidates("claude-opus-4-7[1m]")).toContain("claude-opus-4-7");
    expect(pricingModelCandidates("anthropic/claude-opus-4.8")).toContain("claude-opus-4-8");
    expect(pricingModelCandidates("opus")).toEqual(["opus"]);
  });
});
