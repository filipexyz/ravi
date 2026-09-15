import { describe, expect, it } from "bun:test";
import { TUI_SESSION_USAGE, requireTuiSessionName, resolveTuiSessionArg } from "./session-arg.js";

describe("TUI session argument", () => {
  it("requires a session name instead of defaulting to main", () => {
    expect(() => requireTuiSessionName(undefined)).toThrow(TUI_SESSION_USAGE);
    expect(() => requireTuiSessionName("")).toThrow(TUI_SESSION_USAGE);
    expect(() => requireTuiSessionName("   ")).toThrow(TUI_SESSION_USAGE);
    expect(() => resolveTuiSessionArg(["bun", "src/tui/index.tsx"])).toThrow(TUI_SESSION_USAGE);
  });

  it("accepts an explicit session name", () => {
    expect(requireTuiSessionName("grok-cli-probe")).toBe("grok-cli-probe");
    expect(resolveTuiSessionArg(["bun", "src/tui/index.tsx", "grok-cli-probe"])).toBe("grok-cli-probe");
  });
});
