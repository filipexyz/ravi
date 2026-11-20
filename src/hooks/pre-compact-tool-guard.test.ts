import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { MEMORY_AGENT_TOOLS, createMemoryAgentToolGuard } from "./pre-compact.js";

// Inputs have the shape the SDK delivers to a PreToolUse hook: `tool_name` and a
// nested `tool_input`. The old guard read `file_path` at the top level, saw "",
// and approved everything.
function preToolUse(toolName: string, toolInput: Record<string, unknown>): HookInput {
  return {
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: "toolu_test",
    session_id: "s",
    transcript_path: "/t",
    cwd: "/c",
  } as unknown as HookInput;
}

describe("PreCompact memory agent tool guard", () => {
  let root: string;
  let agentCwd: string;
  let outside: string;
  let transcript: string;
  let guard: ReturnType<typeof createMemoryAgentToolGuard>;
  const decide = async (toolName: string, toolInput: Record<string, unknown>) =>
    (await guard(preToolUse(toolName, toolInput))).decision;

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "ravi-memory-guard-")));
    agentCwd = join(root, "agent");
    outside = join(root, "outside");
    mkdirSync(join(agentCwd, "memory"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "secret");
    writeFileSync(join(agentCwd, "AGENTS.md"), "x");
    symlinkSync(outside, join(agentCwd, "escape"));
    const transcriptDir = join(root, "transcript");
    mkdirSync(transcriptDir);
    transcript = join(transcriptDir, "s.md");
    writeFileSync(transcript, "t");
    guard = createMemoryAgentToolGuard({
      agentCwd,
      memoryPath: join(agentCwd, "MEMORY.md"),
      memoryDir: join(agentCwd, "memory"),
      transcriptPath: transcript,
    });
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("blocks Bash, whatever the command", async () => {
    expect(await decide("Bash", { command: "env; cat ~/.ssh/id_rsa" })).toBe("block");
  });

  it("blocks every tool outside Read/Edit/Write", async () => {
    for (const tool of ["Bash", "WebFetch", "Grep", "Glob", "Task", "NotebookEdit", "mcp__x__y", ""]) {
      expect(await decide(tool, { file_path: join(agentCwd, "MEMORY.md") })).toBe("block");
    }
  });

  it("blocks Write outside the memory paths", async () => {
    expect(await decide("Write", { file_path: "/etc/x", content: "x" })).toBe("block");
    expect(await decide("Write", { file_path: join(agentCwd, "AGENTS.md"), content: "x" })).toBe("block");
    expect(await decide("Edit", { file_path: transcript, old_string: "t", new_string: "u" })).toBe("block");
  });

  it("blocks Read outside the agent cwd and the transcript", async () => {
    expect(await decide("Read", { file_path: "/Users/someone/.ssh/id_rsa" })).toBe("block");
    expect(await decide("Read", { file_path: join(outside, "secret.txt") })).toBe("block");
    expect(await decide("Read", { file_path: "../outside/secret.txt" })).toBe("block");
  });

  it("blocks a symlink inside the cwd that points outside", async () => {
    expect(await decide("Read", { file_path: join(agentCwd, "escape", "secret.txt") })).toBe("block");
    expect(await decide("Write", { file_path: join(agentCwd, "memory", "..", "escape", "x.md"), content: "x" })).toBe(
      "block",
    );
  });

  it("blocks a missing, empty or non-string file_path", async () => {
    expect(await decide("Read", {})).toBe("block");
    expect(await decide("Read", { file_path: "" })).toBe("block");
    expect(await decide("Write", { file_path: 42, content: "x" })).toBe("block");
    expect(await decide("Read", { file_path: `${join(agentCwd, "AGENTS.md")}\0.png` })).toBe("block");
    expect(await guard({ hook_event_name: "PreCompact" } as unknown as HookInput)).toMatchObject({ decision: "block" });
  });

  it("blocks the old flat shape the SDK never sends", async () => {
    expect((await guard({ file_path: "/etc/x", content: "x" } as unknown as HookInput)).decision).toBe("block");
  });

  it("approves MEMORY.md and memory/ for read and write", async () => {
    const memoryPath = join(agentCwd, "MEMORY.md");
    expect(await decide("Write", { file_path: memoryPath, content: "x" })).toBe("approve");
    expect(await decide("Edit", { file_path: memoryPath, old_string: "a", new_string: "b" })).toBe("approve");
    expect(await decide("Read", { file_path: memoryPath })).toBe("approve");
    expect(await decide("Write", { file_path: join(agentCwd, "memory", "2026-11-19.md"), content: "x" })).toBe(
      "approve",
    );
    expect(await decide("Write", { file_path: "MEMORY.md", content: "x" })).toBe("approve");
  });

  it("approves Read of the transcript copy and of files under the cwd", async () => {
    expect(await decide("Read", { file_path: transcript })).toBe("approve");
    expect(await decide("Read", { file_path: join(agentCwd, "AGENTS.md") })).toBe("approve");
  });

  it("answers in both hook output forms", async () => {
    const approved = await guard(preToolUse("Read", { file_path: transcript }));
    expect(approved.hookSpecificOutput).toEqual({ hookEventName: "PreToolUse", permissionDecision: "allow" });
    const blocked = await guard(preToolUse("Bash", { command: "id" }));
    expect(blocked.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(blocked.hookSpecificOutput.permissionDecisionReason).toBeTruthy();
  });

  it("lists exactly Read, Edit and Write", () => {
    expect([...MEMORY_AGENT_TOOLS]).toEqual(["Read", "Edit", "Write"]);
  });
});
