import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

afterAll(() => mock.restore());

const rollupCalls: Array<Record<string, unknown>> = [];
const metricsQueryCalls: Array<Record<string, unknown>> = [];
let dailyRowsMock: Array<Record<string, unknown>> = [];
let rolledDatesMock: string[] = [];

const fullRow = (agentId: string): Record<string, unknown> => ({
  agentId,
  date: "2026-08-01",
  model: "claude-sonnet-4-5",
  inputTokens: 1000,
  outputTokens: 500,
  cacheReadTokens: 100,
  cacheCreationTokens: 50,
  totalCostUsd: 1.5,
  costEventCount: 3,
  turnsComplete: 2,
  turnsFailed: 0,
  turnsInterrupted: 0,
  toolCalls: 5,
  toolErrors: 1,
  totalDurationMs: 12_000,
  rolledUpAt: 1_765_000_000_000,
});

mock.module("../decorators.js", () => ({
  Group: () => () => {},
  Command: () => () => {},
  CommandAccess: () => () => {},
  Scope: () => () => {},
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

mock.module("../../metrics/rollup.js", () => ({
  utcDateString: (ms: number) => new Date(ms).toISOString().slice(0, 10),
  rollupDailyMetrics: (options: Record<string, unknown>) => {
    rollupCalls.push(options);
    return { dates: ["2026-08-01", "2026-08-02"], rowsWritten: 3 };
  },
  getDailyMetrics: (query: Record<string, unknown>) => {
    metricsQueryCalls.push(query);
    return dailyRowsMock;
  },
  getRolledUpDates: () => rolledDatesMock,
}));

const { MetricsCommands } = await import("./metrics.js");
const { ContractError } = await import("../agent-contract.js");

async function captureJson(run: () => unknown | Promise<unknown>): Promise<unknown> {
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
  return JSON.parse(lines[0] ?? "null") as unknown;
}

beforeEach(() => {
  rollupCalls.length = 0;
  metricsQueryCalls.length = 0;
  dailyRowsMock = [];
  rolledDatesMock = [];
});

describe("MetricsCommands --json", () => {
  it("show prints the rolled-up rows and forwards filters", async () => {
    dailyRowsMock = [fullRow("main")];
    const payload = (await captureJson(async () => {
      await new MetricsCommands().show("main", "7", "2026-08-01", "2026-08-03", undefined, true);
    })) as Array<Record<string, unknown>>;

    expect(payload).toHaveLength(1);
    expect(payload[0]).toMatchObject({ agentId: "main", totalCostUsd: 1.5 });
    expect(metricsQueryCalls[0]).toMatchObject({
      agentId: "main",
      since: "2026-08-01",
      through: "2026-08-03",
    });
  });

  it("rollup passes resolved dates through and reports the result", async () => {
    const payload = (await captureJson(async () => {
      await new MetricsCommands().rollup("2026-08-01", "2026-08-03", true);
    })) as Record<string, unknown>;

    expect(rollupCalls[0]).toEqual({ since: "2026-08-01", through: "2026-08-03" });
    expect(payload).toEqual({ dates: ["2026-08-01", "2026-08-02"], rowsWritten: 3 });
  });

  it("rollup resolves --since given as N days ago into a UTC date", async () => {
    await captureJson(async () => {
      await new MetricsCommands().rollup("3", undefined, true);
    });

    expect(String(rollupCalls[0]?.since)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("dates prints the rolled-up date list", async () => {
    rolledDatesMock = ["2026-08-01", "2026-08-02"];
    const payload = (await captureJson(async () => {
      await new MetricsCommands().dates(true);
    })) as string[];

    expect(payload).toEqual(["2026-08-01", "2026-08-02"]);
  });
});

describe("metrics agent-first contract", () => {
  function expectContractError(run: () => unknown | Promise<unknown>): Promise<InstanceType<typeof ContractError>> {
    const originalLog = console.log;
    console.log = () => {};
    return Promise.resolve()
      .then(run)
      .then(
        () => {
          console.log = originalLog;
          throw new Error("expected a ContractError to be thrown");
        },
        (error: unknown) => {
          console.log = originalLog;
          expect(error).toBeInstanceOf(ContractError);
          return error as InstanceType<typeof ContractError>;
        },
      );
  }

  it("emits USAGE_ERROR with acceptedValues on invalid --by (exit 2) without querying", async () => {
    const error = await expectContractError(() =>
      new MetricsCommands().show(undefined, undefined, undefined, undefined, "bogus", true),
    );
    expect(error.exitCode).toBe(2);
    const envelope = error.envelope();
    expect(envelope.success).toBe(false);
    expect(envelope.op).toBe("metrics show");
    expect(envelope.error.code).toBe("USAGE_ERROR");
    expect(envelope.error.acceptedValues).toEqual(["agent", "agent-model", "date"]);
    expect(metricsQueryCalls).toHaveLength(0);
  });

  it("supports --fields compact mode on metrics show", async () => {
    dailyRowsMock = [fullRow("main"), fullRow("vendas")];
    const payload = (await captureJson(async () => {
      await new MetricsCommands().show(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        "agentId,totalCostUsd",
      );
    })) as Array<Record<string, unknown>>;

    expect(payload).toHaveLength(2);
    expect(Object.keys(payload[0] ?? {}).sort()).toEqual(["agentId", "totalCostUsd"]);
  });

  it("declares no braked op: rollup writes derived rows immediately (no --execute)", async () => {
    await captureJson(async () => {
      await new MetricsCommands().rollup(undefined, undefined, true);
    });
    expect(rollupCalls).toHaveLength(1);
  });
});
