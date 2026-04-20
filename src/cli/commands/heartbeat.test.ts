import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

afterAll(() => mock.restore());

const emitMock = mock(async () => {});
const promptMock = mock(async () => {});
const missingHeartbeatCwd = `/tmp/ravi-heartbeat-json-missing-${process.pid}`;

let agents: Array<Record<string, unknown>> = [];

mock.module("../decorators.js", () => ({
  Group: () => () => {},
  Command: () => () => {},
  Scope: () => () => {},
  Arg: () => () => {},
  Option: () => () => {},
}));

mock.module("../context.js", () => ({
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

async function captureJson(run: () => Promise<void> | void): Promise<Record<string, unknown>> {
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
