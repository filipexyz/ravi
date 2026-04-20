import { afterAll, describe, expect, it, mock } from "bun:test";

mock.module("../decorators.js", () => ({
  Group: () => () => {},
  Command: () => () => {},
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
  getSession: () => null,
  resolveSession: () => null,
}));

const { CostCommands } = await import("./costs.js");

function captureJson(run: () => void): Record<string, unknown> {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    run();
  } finally {
    console.log = originalLog;
  }

  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
}

describe("CostCommands --json", () => {
  it("prints a typed summary payload", () => {
    const payload = captureJson(() => {
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

  it("serializes agent breakdown models as arrays", () => {
    const payload = captureJson(() => {
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
});

afterAll(() => mock.restore());
