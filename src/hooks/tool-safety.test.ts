import { describe, expect, it } from "bun:test";
import { getToolSafety } from "./tool-safety.js";

describe("getToolSafety", () => {
  it("classifies read-only tools as safe", () => {
    for (const toolName of ["Read", "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite", "AskUserQuestion"]) {
      expect(getToolSafety(toolName)).toBe("safe");
    }
  });

  it("classifies a Bash sleep as safe regardless of surrounding whitespace", () => {
    expect(getToolSafety("Bash", { command: "sleep 600" })).toBe("safe");
    expect(getToolSafety("Bash", { command: "  sleep 5\n" })).toBe("safe");
  });

  it("classifies any other Bash command as unsafe", () => {
    expect(getToolSafety("Bash", { command: "bun run build" })).toBe("unsafe");
    expect(getToolSafety("Bash", { command: "echo sleep 5" })).toBe("unsafe");
    expect(getToolSafety("Bash", {})).toBe("unsafe");
    expect(getToolSafety("Bash")).toBe("unsafe");
  });

  it("treats tools with side effects and unknown tools as unsafe by default", () => {
    for (const toolName of ["Write", "Edit", "NotebookEdit", "tools_invoke", "mcp__custom__anything", ""]) {
      expect(getToolSafety(toolName)).toBe("unsafe");
    }
  });
});
