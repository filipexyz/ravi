import { describe, expect, it } from "bun:test";

const { ServiceCommands } = await import("./service.js");

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
});
