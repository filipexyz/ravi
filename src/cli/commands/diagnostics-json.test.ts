import { afterAll, describe, expect, it, mock } from "bun:test";

afterAll(() => mock.restore());

mock.module("../decorators.js", () => ({
  Group: () => () => {},
  Command: () => () => {},
  Scope: () => () => {},
  Arg: () => () => {},
  Option: () => () => {},
}));

mock.module("../../nats.js", () => ({
  subscribe: mock(() => (async function* () {})()),
}));

mock.module("../../tmux/manager.js", () => ({
  parseSessionNameFromPromptTopic: () => "main",
  RaviTmuxManager: class {
    async listManagedSessions() {
      return [
        {
          tmuxSessionName: "ravi-dev",
          windows: [
            {
              name: "main",
              paneId: "%1",
              paneDead: false,
            },
          ],
        },
      ];
    }
  },
}));

const { ServiceCommands } = await import("./service.js");
const { TmuxCommands } = await import("./tmux.js");

async function captureConsole<T>(run: () => T | Promise<T>): Promise<{ output: string; result: T }> {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    const result = await run();
    return { output: lines.join("\n"), result };
  } finally {
    console.log = originalLog;
  }
}

describe("diagnostics JSON output", () => {
  it("reports TUI JSON mode as an explicit non-launch contract", async () => {
    const { output } = await captureConsole(() => new ServiceCommands().tui("agent:main:main", true));
    const payload = JSON.parse(output);

    expect(payload).toMatchObject({
      success: false,
      service: "tui",
      started: false,
      supported: false,
      reason: expect.stringContaining("JSON mode does not launch it"),
      command: "bun",
      args: ["src/tui.tsx", "agent:main:main"],
    });
  });

  it("prints tmux sessions as typed JSON", async () => {
    const { output, result } = await captureConsole(() => new TmuxCommands().list(true));
    const payload = JSON.parse(output);

    expect(payload).toEqual({
      total: 1,
      sessions: [
        {
          tmuxSessionName: "ravi-dev",
          windows: [
            {
              name: "main",
              paneId: "%1",
              paneDead: false,
            },
          ],
        },
      ],
    });
    expect(result).toEqual(payload.sessions);
  });
});
