import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

afterAll(() => mock.restore());

const emitMock = mock(async () => {});
const promptMock = mock(async () => {});
const missingHeartbeatCwd = `/tmp/ravi-heartbeat-json-missing-${process.pid}`;

let agents: Array<Record<string, unknown>> = [];

mock.module("../decorators.js", () => ({
  Group: () => () => {},
  Command: () => () => {},
  CommandAccess: () => () => {},
  Scope: () => () => {},
  CliOnly: () => () => {},
  Returns: Object.assign(() => () => {}, { binary: () => () => {} }),
  Arg: () => () => {},
  Option: () => () => {},
}));

mock.module("../context.js", () => ({
  // Real hasContext checks RAVI_* envs; the contract helpers use it to throw
  // ContractError instead of process.exit, which is what tests need.
  hasContext: () => true,
  // Exported defensively: bun's mock.module leaks across test files in a
  // shared process, and sibling command modules import getContext.
  getContext: () => undefined,
  fail: (message: string) => {
    throw new Error(message);
  },
}));

mock.module("../../nats.js", () => ({
  nats: {
    emit: emitMock,
  },
}));

mock.module("../../omni/session-stream.js", () => ({
  publishSessionPrompt: promptMock,
}));

mock.module("../../router/index.js", () => ({
  expandHome: (value: string) => value,
  getMainSession: (id: string) => ({ name: `${id}-main` }),
}));

mock.module("../../router/config.js", () => ({
  getAgent: (id: string) => agents.find((agent) => agent.id === id) ?? null,
  getAllAgents: () => agents,
}));

mock.module("../../heartbeat/index.js", () => ({
  getAgentHeartbeatConfig: (id: string) =>
    (agents.find((agent) => agent.id === id)?.heartbeat as Record<string, unknown> | undefined) ?? null,
  updateAgentHeartbeatConfig: (id: string, updates: Record<string, unknown>) => {
    const agent = agents.find((item) => item.id === id);
    if (!agent) throw new Error(`Agent not found: ${id}`);
    agent.heartbeat = {
      ...((agent.heartbeat as Record<string, unknown> | undefined) ?? {}),
      ...updates,
    };
    return agent;
  },
  parseDuration: (value: string) => (value === "1h" ? 3_600_000 : 1_800_000),
  formatDuration: (value: number) => (value === 3_600_000 ? "1h" : "30m"),
  parseActiveHours: (value: string) => {
    const [start, end] = value.split("-");
    return { start, end };
  },
  HEARTBEAT_PROMPT: "heartbeat prompt",
}));

const { HeartbeatCommands } = await import("./heartbeat.js");
const { ContractError } = await import("../agent-contract.js");

type ContractErrorInstance = InstanceType<typeof ContractError>;

async function captureJson(run: () => Promise<unknown> | unknown): Promise<Record<string, unknown>> {
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

  return JSON.parse(lines.join("\n")) as Record<string, unknown>;
}

describe("HeartbeatCommands --json", () => {
  beforeEach(() => {
    emitMock.mockClear();
    promptMock.mockClear();
    agents = [
      {
        id: "dev",
        name: "Dev",
        cwd: missingHeartbeatCwd,
        model: "sonnet",
        heartbeat: {
          enabled: false,
          intervalMs: 1_800_000,
          lastRunAt: 123,
        },
      },
    ];
  });

  it("lists heartbeat configs as structured JSON", async () => {
    const payload = await captureJson(() => new HeartbeatCommands().status(true));

    expect(payload).toMatchObject({
      total: 1,
      agents: [
        {
          agent: {
            id: "dev",
            name: "Dev",
          },
          heartbeat: {
            enabled: false,
            intervalMs: 1_800_000,
            intervalDescription: "30m",
            lastRunAt: 123,
          },
        },
      ],
    });
  });

  it("returns the updated heartbeat config for enable --json", async () => {
    const payload = await captureJson(() => new HeartbeatCommands().enable("dev", "1h", true));

    expect(payload).toMatchObject({
      status: "enabled",
      target: { type: "heartbeat", agentId: "dev" },
      changedCount: 1,
      heartbeat: {
        enabled: true,
        intervalMs: 3_600_000,
        intervalDescription: "1h",
      },
    });
    expect(emitMock).toHaveBeenCalledTimes(1);
  });

  it("returns a skipped trigger result when HEARTBEAT.md is missing in --json mode", async () => {
    const payload = await captureJson(() => new HeartbeatCommands().trigger("dev", true));

    expect(payload).toMatchObject({
      status: "skipped",
      reason: "missing_heartbeat_file",
      target: { type: "heartbeat", agentId: "dev" },
      changedCount: 0,
    });
    expect(promptMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Agent-first contract (Manual v2): heartbeat declares NO braked op — trigger
// fires the agent's own heartbeat (benign, frequent) and enable/disable/set
// are reversible — so the contract surface here is the AGENT_NOT_FOUND
// envelope (exit 1 + suggestions) and compact `--fields` mode.
// ---------------------------------------------------------------------------

async function silenced<T>(run: () => Promise<T> | T): Promise<T> {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

async function expectContractError(
  run: () => Promise<unknown> | unknown,
  code: string,
  exitCode: number,
): Promise<ContractErrorInstance> {
  let caught: unknown;
  await silenced(async () => {
    try {
      await run();
    } catch (error) {
      caught = error;
    }
  });
  expect(caught).toBeInstanceOf(ContractError);
  const contractError = caught as ContractErrorInstance;
  expect(contractError.code).toBe(code);
  expect(contractError.exitCode).toBe(exitCode);
  return contractError;
}

describe("HeartbeatCommands agent-first contract", () => {
  const heartbeatWorkspaces: string[] = [];

  beforeEach(() => {
    emitMock.mockClear();
    promptMock.mockClear();
    agents = [
      {
        id: "dev",
        name: "Dev",
        cwd: missingHeartbeatCwd,
        model: "sonnet",
        heartbeat: {
          enabled: false,
          intervalMs: 1_800_000,
          lastRunAt: 123,
        },
      },
    ];
  });

  afterAll(() => {
    for (const workspace of heartbeatWorkspaces) {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("show on an unknown agent exits 1 with AGENT_NOT_FOUND and suggestions from the local agent list", async () => {
    const error = await expectContractError(() => new HeartbeatCommands().show("ghost", true), "AGENT_NOT_FOUND", 1);

    expect(error.details.suggestions).toContain("dev");
    expect(error.details.suggestedAction).toContain("ravi agents list");
  });

  it("enable on an unknown agent exits 1 with AGENT_NOT_FOUND and writes nothing", async () => {
    await expectContractError(() => new HeartbeatCommands().enable("ghost", "1h", true), "AGENT_NOT_FOUND", 1);

    expect(emitMock).not.toHaveBeenCalled();
    expect((agents[0]?.heartbeat as Record<string, unknown>).enabled).toBe(false);
  });

  it("trigger on an unknown agent exits 1 with AGENT_NOT_FOUND and publishes no prompt", async () => {
    await expectContractError(() => new HeartbeatCommands().trigger("ghost", true), "AGENT_NOT_FOUND", 1);

    expect(promptMock).not.toHaveBeenCalled();
  });

  it("trigger with pending work but without --execute dry-runs before publishing a prompt", async () => {
    const heartbeatWorkspace = mkdtempSync(join(tmpdir(), "ravi-heartbeat-contract-"));
    heartbeatWorkspaces.push(heartbeatWorkspace);
    writeFileSync(join(heartbeatWorkspace, "HEARTBEAT.md"), "- tarefa pendente\n");
    agents[0]!.cwd = heartbeatWorkspace;

    const error = await expectContractError(
      () => new HeartbeatCommands().trigger("dev", true),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.plan).toEqual({
      agentId: "dev",
      heartbeatFilePresent: true,
    });
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("trigger with --execute publishes the heartbeat prompt", async () => {
    const heartbeatWorkspace = mkdtempSync(join(tmpdir(), "ravi-heartbeat-contract-"));
    heartbeatWorkspaces.push(heartbeatWorkspace);
    writeFileSync(join(heartbeatWorkspace, "HEARTBEAT.md"), "- tarefa pendente\n");
    agents[0]!.cwd = heartbeatWorkspace;

    const payload = await captureJson(() => new HeartbeatCommands().trigger("dev", true, true));

    expect(payload).toMatchObject({
      status: "triggered",
      target: { type: "heartbeat", agentId: "dev" },
      sessionName: "dev-main",
    });
    expect(promptMock).toHaveBeenCalledTimes(1);
  });

  it("status --fields narrows each item to the requested top-level fields", async () => {
    const payload = await captureJson(() => new HeartbeatCommands().status(true, "agent,heartbeatFileExists"));

    expect(payload.total).toBe(1);
    for (const item of payload.agents as Array<Record<string, unknown>>) {
      expect(Object.keys(item).sort()).toEqual(["agent", "heartbeatFileExists"]);
    }
  });
});
