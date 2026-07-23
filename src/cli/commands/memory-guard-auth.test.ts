import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithContext } from "../context.js";
import { dbCreateAgent } from "../../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { dbCreateTask, dbDispatchTask } from "../../tasks/task-db.js";
import { MemoryCommands } from "./memory.js";

describe("MemoryCommands.guard authenticated curator boundary", () => {
  let stateDir: string | null = null;
  let root: string;
  let agentA: string;
  let agentB: string;
  let taskId: string;
  const sessionName = "memory-curator-session";

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-memory-guard-auth-");
    root = mkdtempSync(join(tmpdir(), "ravi-memory-guard-auth-root-"));
    agentA = join(root, "agent-a");
    agentB = join(root, "agent-b");
    mkdirSync(join(agentA, "memory"), { recursive: true });
    mkdirSync(join(agentB, "memory"), { recursive: true });
    writeFileSync(join(agentA, "MEMORY.md"), "", "utf-8");
    writeFileSync(join(agentB, "MEMORY.md"), "", "utf-8");
    dbCreateAgent({ id: "agent-a", cwd: agentA });
    dbCreateAgent({ id: "agent-b", cwd: agentB });
    const created = dbCreateTask({
      title: "Curate memory",
      instructions: "test",
      profileId: "curador-memoria",
      createdBy: "runtime:memory-nudge",
      createdByAgentId: "agent-a",
      createdBySessionName: "origin-session",
      profileInput: {
        agent_id: "agent-a",
        originator_session_key: "origin-key",
        originator_session: "origin-session",
        highest_message_id: "10",
      },
    });
    taskId = created.task.id;
    dbDispatchTask(taskId, {
      agentId: "agent-a",
      sessionName,
      assignedBy: "runtime:memory-nudge",
      assignedByAgentId: "agent-a",
      assignedBySessionName: "origin-session",
    });
  });

  afterEach(async () => {
    rmSync(root, { recursive: true, force: true });
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("writes only the authenticated agent canonical store", async () => {
    const commands = new MemoryCommands();

    await runWithContext(curatorContext("agent-a", sessionName, taskId), () =>
      guard(commands, join(agentA, "MEMORY.md"), "- Agent A durable fact", "agent-a", taskId),
    );

    expect(readFileSync(join(agentA, "MEMORY.md"), "utf-8")).toContain("Agent A durable fact");
  });

  it("rejects asserted cross-agent identity, cross-agent target, arbitrary cwd target, and symlink escapes", async () => {
    const commands = new MemoryCommands();
    const context = curatorContext("agent-a", sessionName, taskId);

    await expect(
      runWithContext(context, () => guard(commands, join(agentA, "MEMORY.md"), "- nope", "agent-b", taskId)),
    ).rejects.toThrow(/--agent must match/);

    await expect(
      runWithContext(context, () => guard(commands, join(agentB, "MEMORY.md"), "- nope", "agent-a", taskId)),
    ).rejects.toThrow(/authenticated agent/);

    await expect(
      runWithContext(context, () => guard(commands, join(agentA, "AGENTS.md"), "- nope", "agent-a", taskId)),
    ).rejects.toThrow(/MEMORY\.md or a file below its memory\/ store/);

    rmSync(join(agentA, "memory"), { recursive: true, force: true });
    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(agentA, "memory"));
    await expect(
      runWithContext(context, () => guard(commands, join(agentA, "memory", "topic.md"), "- nope", "agent-a", taskId)),
    ).rejects.toThrow(/symlink component/);
  });
});

function guard(commands: MemoryCommands, target: string, candidate: string, agentId: string, taskId: string) {
  return commands.guard(
    target,
    undefined,
    candidate,
    agentId,
    "10",
    undefined,
    undefined,
    "origin-key",
    "origin-session",
    undefined,
    taskId,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    true,
  );
}

function curatorContext(agentId: string, sessionName: string, taskId: string) {
  return {
    agentId,
    sessionName,
    suppressCliOutput: true,
    context: {
      contextId: "ctx-test",
      kind: "turn-runtime",
      agentId,
      sessionName,
      capabilities: [],
      metadata: {
        authorityMode: "agent-identity",
        taskSelfTaskId: taskId,
      },
    } as any,
  };
}
