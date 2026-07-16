import { describe, expect, it } from "bun:test";
import { createMemoryGuardHook } from "./host-hooks.js";
import type { AgentConfig } from "../router/index.js";

const agent = { id: "sde", cwd: "/home/ravi/sde" } as unknown as AgentConfig;

const curatorBinding = () => ({ task: { profileId: "curador-memoria" } });
const nonCuratorBinding = () => ({ task: { profileId: "default" } });
const noBinding = () => null;

function call(hook: ReturnType<typeof createMemoryGuardHook>, toolName: string, filePath: string): Promise<any> {
  return hook({ tool_name: toolName, tool_input: { file_path: filePath } });
}

describe("createMemoryGuardHook (M2 — enforce deterministic memory guard)", () => {
  it("DENIES a curator Write to MEMORY.md", async () => {
    const hook = createMemoryGuardHook("sde-curator", agent, curatorBinding);
    const res = await call(hook, "Write", "/home/ravi/sde/MEMORY.md");
    expect(res.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(res.hookSpecificOutput?.permissionDecisionReason).toContain("ravi memory guard");
  });

  it("DENIES a curator Edit to a topic file under memory/", async () => {
    const hook = createMemoryGuardHook("sde-curator", agent, curatorBinding);
    const res = await call(hook, "Edit", "/home/ravi/sde/memory/2026-07-15.md");
    expect(res.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("DENIES a curator relative-path write that resolves into memory/", async () => {
    const hook = createMemoryGuardHook("sde-curator", agent, curatorBinding);
    const res = await call(hook, "MultiEdit", "memory/topic.md");
    expect(res.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("ALLOWS a curator Write to its own TASK.md (outside memory)", async () => {
    const hook = createMemoryGuardHook("sde-curator", agent, curatorBinding);
    const res = await call(hook, "Write", "/home/ravi/.ravi/tasks/task-x/TASK.md");
    expect(res).toEqual({});
  });

  it("ALLOWS a curator write to an unrelated file under cwd (e.g. AGENTS.md)", async () => {
    const hook = createMemoryGuardHook("sde-curator", agent, curatorBinding);
    const res = await call(hook, "Write", "/home/ravi/sde/AGENTS.md");
    expect(res).toEqual({});
  });

  it("does NOT block a path that merely prefixes 'memory' (memory-notes.md)", async () => {
    const hook = createMemoryGuardHook("sde-curator", agent, curatorBinding);
    const res = await call(hook, "Write", "/home/ravi/sde/memory-notes.md");
    expect(res).toEqual({});
  });

  it("ALLOWS a NON-curator session to write MEMORY.md directly", async () => {
    const hook = createMemoryGuardHook("sde-main", agent, nonCuratorBinding);
    const res = await call(hook, "Write", "/home/ravi/sde/MEMORY.md");
    expect(res).toEqual({});
  });

  it("ALLOWS when there is no active task binding", async () => {
    const hook = createMemoryGuardHook("sde-main", agent, noBinding);
    const res = await call(hook, "Write", "/home/ravi/sde/MEMORY.md");
    expect(res).toEqual({});
  });

  it("IGNORES non-write tools (Read stays allowed for the curator)", async () => {
    const hook = createMemoryGuardHook("sde-curator", agent, curatorBinding);
    const res = await hook({ tool_name: "Read", tool_input: { file_path: "/home/ravi/sde/MEMORY.md" } });
    expect(res).toEqual({});
  });

  it("fails OPEN when the binding lookup throws (never wedges a turn)", async () => {
    const throwing = () => {
      throw new Error("db down");
    };
    const hook = createMemoryGuardHook("sde-curator", agent, throwing);
    const res = await call(hook, "Write", "/home/ravi/sde/MEMORY.md");
    expect(res).toEqual({});
  });

  it("blocks NotebookEdit via notebook_path too", async () => {
    const hook = createMemoryGuardHook("sde-curator", agent, curatorBinding);
    const res = await hook({
      tool_name: "NotebookEdit",
      tool_input: { notebook_path: "/home/ravi/sde/memory/notes.md" },
    });
    expect(res.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});
