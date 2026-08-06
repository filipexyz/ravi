import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

let pricingUpdates: unknown[] = [];

type MockCostSummary = {
  total_cost: number;
  total_input: number;
  total_output: number;
  total_cache_read: number;
  total_cache_creation: number;
  turns: number;
};

const zeroSummary = (): MockCostSummary => ({
  total_cost: 0,
  total_input: 0,
  total_output: 0,
  total_cache_read: 0,
  total_cache_creation: 0,
  turns: 0,
});

let agentCostMock: MockCostSummary = zeroSummary();
let sessionCostMock: MockCostSummary = zeroSummary();
let topSessionsMock: Array<Record<string, unknown>> = [];
let knownAgentIds: string[] = [];

mock.module("../decorators.js", () => ({
  Group: () => () => {},
  Command: () => () => {},
  CommandAccess: () => () => {},
  CliOnly: () => () => {},
  Returns: Object.assign(() => () => {}, { binary: () => () => {} }),
  Arg: () => () => {},
  Option: () => () => {},
}));

const actualCliContextModule = await import("../context.js");

mock.module("../context.js", () => ({
  ...actualCliContextModule,
  // Real hasContext checks RAVI_* envs; the contract helpers use it to throw
  // ContractError instead of process.exit, which is what tests need.
  hasContext: () => true,
  fail: (message: string) => {
    throw new Error(message);
  },
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
  dbGetCostForAgent: () => agentCostMock,
  dbGetCostForSession: () => sessionCostMock,
  dbGetTopSessions: () => topSessionsMock,
  getAgent: (agentId: string) => (knownAgentIds.includes(agentId) ? { id: agentId } : null),
  getAllAgents: () => [
    { id: "main", name: "Main" },
    { id: "vendas", name: null },
  ],
  listSessions: () => [
    { sessionKey: "agent:main:main", name: "main-session" },
    { sessionKey: "agent:vendas:main", name: "vendas-session" },
  ],
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
const { ContractError } = await import("../agent-contract.js");

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

describe("costs agent-first contract", () => {
  beforeEach(() => {
    pricingUpdates = [];
    agentCostMock = zeroSummary();
    sessionCostMock = zeroSummary();
    topSessionsMock = [];
    knownAgentIds = [];
  });

  function expectContractError(run: () => unknown): InstanceType<typeof ContractError> {
    const originalLog = console.log;
    console.log = () => {};
    let thrown: unknown;
    try {
      run();
    } catch (error) {
      thrown = error;
    } finally {
      console.log = originalLog;
    }
    expect(thrown).toBeInstanceOf(ContractError);
    return thrown as InstanceType<typeof ContractError>;
  }

  it("emits AGENT_NOT_FOUND envelope with suggestions on --json (exit 1)", () => {
    const error = expectContractError(() => new CostCommands().agent("mainn", "24", true));
    expect(error.exitCode).toBe(1);
    const envelope = error.envelope();
    expect(envelope.success).toBe(false);
    expect(envelope.op).toBe("costs agent");
    expect(envelope.error.code).toBe("AGENT_NOT_FOUND");
    expect(envelope.error.suggestions).toContain("main");
    expect((envelope.error.suggestions as string[]).length).toBeLessThanOrEqual(3);
  });

  it("keeps returning numbers for a deleted agent that still has cost history", async () => {
    agentCostMock = { ...zeroSummary(), total_cost: 2, total_input: 10, turns: 4 };
    const payload = await captureJson(() => {
      new CostCommands().agent("ghost", "24", true);
    });
    expect(payload.agentId).toBe("ghost");
    expect(payload.summary).toMatchObject({ turns: 4, total_cost: 2 });
  });

  it("emits SESSION_NOT_FOUND envelope with suggestions on --json (exit 1)", () => {
    const error = expectContractError(() => new CostCommands().session("main-sesion", true));
    expect(error.exitCode).toBe(1);
    const envelope = error.envelope();
    expect(envelope.op).toBe("costs session");
    expect(envelope.error.code).toBe("SESSION_NOT_FOUND");
    expect(envelope.error.suggestions).toContain("main-session");
  });

  it("keeps the raw-key fallback for unresolved sessions that still have cost history", async () => {
    sessionCostMock = { ...zeroSummary(), total_cost: 1, turns: 2 };
    const payload = await captureJson(() => {
      new CostCommands().session("agent:pruned:main", true);
    });
    expect(payload.sessionKey).toBe("agent:pruned:main");
    expect(payload.sessionName).toBeNull();
    expect(payload.summary).toMatchObject({ turns: 2 });
  });

  it("supports --fields compact mode on costs agents", async () => {
    const payload = await captureJson(() => {
      new CostCommands().agents("24", "10", true, "agentId,total_cost");
    });
    const agents = payload.agents as Array<Record<string, unknown>>;
    expect(agents).toHaveLength(1);
    expect(Object.keys(agents[0] ?? {}).sort()).toEqual(["agentId", "total_cost"]);
  });

  it("supports --fields compact mode on costs top-sessions", async () => {
    topSessionsMock = [
      {
        session_key: "agent:main:main",
        total_cost: 3,
        total_input: 100,
        total_output: 50,
        total_cache_read: 0,
        total_cache_creation: 0,
        turns: 5,
      },
    ];
    const payload = await captureJson(() => {
      new CostCommands().topSessions("24", "10", true, "sessionKey,total_cost");
    });
    const sessions = payload.sessions as Array<Record<string, unknown>>;
    expect(sessions).toHaveLength(1);
    expect(Object.keys(sessions[0] ?? {}).sort()).toEqual(["sessionKey", "total_cost"]);
  });

  it("supports --fields compact mode on costs pricing coverage rows", async () => {
    const payload = await captureJson(async () => {
      await new CostCommands().pricing("24", true, undefined, undefined, undefined, undefined, "model,events");
    });
    const rows = payload.rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(["events", "model"]);
  });

  it("previews recompute with --dry-run: reports rows and writes nothing", async () => {
    const payload = await captureJson(async () => {
      await new CostCommands().pricing("24", true, true, "10", undefined, true);
    });
    expect(payload.recompute).toEqual(
      expect.objectContaining({
        dryRun: true,
        attempted: 1,
        updated: 0,
        priced: 1,
        unpriced: 0,
      }),
    );
    const recompute = payload.recompute as { rows: Array<Record<string, unknown>> };
    expect(recompute.rows).toHaveLength(1);
    expect(recompute.rows[0]).toMatchObject({ id: 123, pricingStatus: "priced" });
    expect(pricingUpdates).toHaveLength(0);
  });
});

afterAll(() => mock.restore());
