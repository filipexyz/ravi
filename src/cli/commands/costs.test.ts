import { afterAll, describe, expect, it, mock } from "bun:test";

let pricingUpdates: unknown[] = [];

mock.module("../decorators.js", () => ({
  Group: () => () => {},
  Command: () => () => {},
  CommandAccess: () => () => {},
  CliOnly: () => () => {},
  Returns: Object.assign(() => () => {}, { binary: () => () => {} }),
  Arg: () => () => {},
  Option: () => () => {},
}));

mock.module("../../router/index.js", () => ({
  dbGetCostSummary: () => ({
    total_cost: 1.25,
    total_input: 1000,
    total_output: 500,
    total_cache_read: 250,
    total_cache_creation: 125,
    turns: 3,
  }),
  dbGetCostByAgent: () => [
    {
      agent_id: "main",
      model: "gpt-5.4",
      total_cost: 1,
      total_input: 100,
      total_output: 50,
      total_cache_read: 10,
      total_cache_creation: 5,
      turns: 2,
    },
    {
      agent_id: "main",
      model: "gpt-5.4-mini",
      total_cost: 0.5,
      total_input: 50,
      total_output: 25,
      total_cache_read: 5,
      total_cache_creation: 0,
      turns: 1,
    },
  ],
  dbGetCostForAgent: () => ({
    total_cost: 0,
    total_input: 0,
    total_output: 0,
    total_cache_read: 0,
    total_cache_creation: 0,
    turns: 0,
  }),
  dbGetCostForSession: () => ({
    total_cost: 0,
    total_input: 0,
    total_output: 0,
    total_cache_read: 0,
    total_cache_creation: 0,
    turns: 0,
  }),
  dbGetTopSessions: () => [],
  dbListCostEventsForPricingRecompute: () => [
    {
      id: 123,
      model: "claude-haiku-4-5",
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      pricing_status: "legacy",
      created_at: 1_765_000_000_000,
    },
  ],
  dbUpdateCostEventPricing: (update: unknown) => {
    pricingUpdates.push(update);
  },
  dbGetCostPricingCoverage: () => [
    {
      pricing_status: "unpriced",
      model: "claude-opus-4-9",
      pricing_model: null,
      pricing_source: null,
      events: 2,
      total_cost: 0,
      total_input: 100,
      total_output: 50,
      total_cache_read: 10,
      total_cache_creation: 5,
      last_created_at: 1_765_000_000_000,
    },
  ],
  getSession: () => null,
  resolveSession: () => null,
}));

mock.module("../../costs/pricing-catalog.js", () => ({
  loadPricingCatalog: async () => ({
    source: "test",
    sourceUrl: "https://example.test/prices.json",
    sourceVersion: "v1",
    fetchedAt: 1_765_000_000_000,
    stale: false,
    entries: {},
  }),
  calculateCost: async () => ({
    inputCost: 1,
    outputCost: 5,
    cacheCost: 0,
    totalCost: 6,
    pricingStatus: "priced",
    pricing: {
      source: "test",
      sourceUrl: "https://example.test/prices.json",
      sourceVersion: "v1",
      fetchedAt: 1_765_000_000_000,
      model: "claude-haiku-4-5",
      stale: false,
    },
  }),
}));

const { CostCommands } = await import("./costs.js");

async function captureJson(run: () => unknown | Promise<unknown>): Promise<Record<string, unknown>> {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    await run();
  } finally {
    console.log = originalLog;
  }

  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
}

describe("CostCommands --json", () => {
  it("prints a typed summary payload", async () => {
    const payload = await captureJson(() => {
      new CostCommands().summary("6", true);
    });

    expect(payload.window).toMatchObject({
      requestedHours: "6",
      effectiveHours: 6,
    });
    expect(payload.summary).toMatchObject({
      total_cost: 1.25,
      total_tokens: 1875,
      turns: 3,
    });
  });

  it("serializes agent breakdown models as arrays", async () => {
    const payload = await captureJson(() => {
      new CostCommands().agents("24", "10", true);
    });

    expect(payload.totalAgents).toBe(1);
    expect(payload.agents).toEqual([
      expect.objectContaining({
        agentId: "main",
        total_cost: 1.5,
        total_tokens: 245,
        turns: 3,
        models: ["gpt-5.4", "gpt-5.4-mini"],
      }),
    ]);
  });

  it("serializes pricing coverage", async () => {
    const payload = await captureJson(async () => {
      await new CostCommands().pricing("24", true);
    });

    expect(payload.rows).toEqual([
      expect.objectContaining({
        pricingStatus: "unpriced",
        model: "claude-opus-4-9",
        totalTokens: 165,
        events: 2,
      }),
    ]);
  });

  it("recomputes pricing rows when requested", async () => {
    pricingUpdates = [];
    const payload = await captureJson(async () => {
      await new CostCommands().pricing("24", true, true, "10");
    });

    expect(payload.recompute).toEqual(
      expect.objectContaining({
        attempted: 1,
        updated: 1,
        priced: 1,
        unpriced: 0,
      }),
    );
    expect(pricingUpdates).toEqual([
      expect.objectContaining({
        id: 123,
        totalCostUsd: 6,
        pricingStatus: "priced",
        pricingModel: "claude-haiku-4-5",
      }),
    ]);
  });
});

afterAll(() => mock.restore());
