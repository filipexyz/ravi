import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRecentHistory, saveMessage } from "../db.js";

const actualTasksIndexModule = await import("../tasks/index.js");

const promptCalls: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
const taskCommentCalls: Array<{ taskId: string; payload: Record<string, unknown> }> = [];
const createTaskCalls: Array<{ input: Record<string, unknown> }> = [];
const dispatchCalls: Array<{ taskId: string; input: Record<string, unknown> }> = [];

mock.module("../omni/session-stream.js", () => ({
  publishSessionPrompt: mock(async (sessionName: string, payload: Record<string, unknown>) => {
    promptCalls.push({ sessionName, payload });
  }),
}));

mock.module("../tasks/index.js", () => ({
  ...actualTasksIndexModule,
  commentTask: mock(async (taskId: string, payload: Record<string, unknown>) => {
    taskCommentCalls.push({ taskId, payload });
    return {};
  }),
  listTasks: () => [],
  createTask: mock((input: Record<string, unknown>) => {
    createTaskCalls.push({ input });
    const now = Date.now();
    return {
      task: {
        id: `spike-task-${createTaskCalls.length}`,
        title: input.title,
        instructions: input.instructions,
        profileId: input.profileId,
        createdAt: now,
        updatedAt: now,
      },
      event: { id: `event-${now}`, taskId: `spike-task-${createTaskCalls.length}` },
      relatedEvents: [],
    };
  }),
  queueOrDispatchTask: mock(async (taskId: string, input: Record<string, unknown>) => {
    dispatchCalls.push({ taskId, input });
    return { launched: true, launchResult: null };
  }),
}));

const { dbCreateHook, dbDeleteHook, dbGetHook, runHookById } = await import("./index.js");

const createdHookIds: string[] = [];

beforeEach(() => {
  promptCalls.length = 0;
  taskCommentCalls.length = 0;
  createTaskCalls.length = 0;
  dispatchCalls.length = 0;
});

afterEach(() => {
  while (createdHookIds.length > 0) {
    const id = createdHookIds.pop();
    if (id) {
      dbDeleteHook(id);
    }
  }
});

describe("hooks-runtime runner", () => {
  it("executes inject_context and persists fire state", async () => {
    const created = dbCreateHook({
      name: "session bridge",
      eventName: "SessionStart",
      scopeType: "session",
      scopeValue: "hook-session",
      actionType: "inject_context",
      actionPayload: {
        message: "workspace ready for {{sessionName}}",
      },
    });
    createdHookIds.push(created.id);

    const result = await runHookById(created.id, {
      eventName: "SessionStart",
      source: "test",
      sessionName: "hook-session",
      agentId: "dev",
      cwd: process.cwd(),
    });

    expect(result.skipped).toBeUndefined();
    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0]).toEqual({
      sessionName: "hook-session",
      payload: expect.objectContaining({
        prompt: "[System] Inform: workspace ready for hook-session",
        deliveryBarrier: "after_response",
        deliveryBarrierSource: "default",
        _hook: true,
        _hookId: created.id,
      }),
    });

    const stored = dbGetHook(created.id);
    expect(stored?.fireCount).toBe(1);
    expect(typeof stored?.lastFiredAt).toBe("number");
  });

  it("rejects invalid hook delivery barriers instead of falling back to steer", async () => {
    const created = dbCreateHook({
      name: "bad barrier",
      eventName: "SessionStart",
      scopeType: "session",
      scopeValue: "hook-session",
      actionType: "send_session_event",
      actionPayload: {
        message: "workspace ready",
        deliveryBarrier: "folowup" as never,
      },
    });
    createdHookIds.push(created.id);

    await expect(
      runHookById(created.id, {
        eventName: "SessionStart",
        source: "test",
        sessionName: "hook-session",
        agentId: "dev",
        cwd: process.cwd(),
      }),
    ).rejects.toThrow("Unknown hook deliveryBarrier");

    expect(promptCalls).toHaveLength(0);
    expect(dbGetHook(created.id)?.fireCount).toBe(0);
  });

  it("dedupes append_history hooks with the same resolved key", async () => {
    const sessionName = `history-${Date.now()}`;
    const created = dbCreateHook({
      name: "observer",
      eventName: "PostToolUse",
      scopeType: "session",
      scopeValue: sessionName,
      actionType: "append_history",
      actionPayload: {
        message: "tool={{toolName}} path={{path}}",
      },
      dedupeKey: "{{eventName}}:{{sessionName}}:{{path}}",
    });
    createdHookIds.push(created.id);

    const event = {
      eventName: "PostToolUse" as const,
      source: "test",
      sessionName,
      agentId: "dev",
      cwd: process.cwd(),
      path: `${process.cwd()}/src/file.ts`,
      toolName: "Write",
      toolInput: { file_path: "src/file.ts" },
    };

    const first = await runHookById(created.id, event);
    const second = await runHookById(created.id, event);

    expect(first.skipped).toBeUndefined();
    expect(second.skipped).toBe("dedupe");

    const messages = getRecentHistory(sessionName, 10).filter((message) => message.content.includes("tool=Write"));
    expect(messages).toHaveLength(1);
  });

  it("routes comment_task to the resolved task target", async () => {
    const created = dbCreateHook({
      name: "task observer",
      eventName: "Stop",
      scopeType: "task",
      scopeValue: "task-abc",
      actionType: "comment_task",
      actionPayload: {
        body: "hook saw {{eventName}} for {{taskId}}",
      },
    });
    createdHookIds.push(created.id);

    await runHookById(created.id, {
      eventName: "Stop",
      source: "test",
      sessionName: "task-abc-work",
      taskId: "task-abc",
      agentId: "dev",
      cwd: process.cwd(),
    });

    expect(taskCommentCalls).toEqual([
      {
        taskId: "task-abc",
        payload: expect.objectContaining({
          body: "hook saw Stop for task-abc",
        }),
      },
    ]);
  });

  it("dispatches a task via dispatch_task action on Stop", async () => {
    const created = dbCreateHook({
      name: "memory-curator",
      eventName: "Stop",
      scopeType: "agent",
      scopeValue: "ravi-dev",
      actionType: "dispatch_task",
      actionPayload: {
        profileId: "default",
        title: "Curate memory for {{agentId}} after {{eventName}}",
        targetAgentId: "curator-agent",
        instructions: "Extract salient facts from the last {{sessionName}} turns.",
        profileInputJson: '{"agent_id":"{{agentId}}","cadence":"3"}',
      },
    });
    createdHookIds.push(created.id);

    const result = await runHookById(created.id, {
      eventName: "Stop",
      source: "test",
      sessionName: "memory-driver",
      agentId: "ravi-dev",
      cwd: process.cwd(),
    });

    expect(result.skipped).toBeUndefined();
    expect(createTaskCalls).toHaveLength(1);
    expect(createTaskCalls[0]!.input).toEqual(
      expect.objectContaining({
        title: "Curate memory for ravi-dev after Stop",
        instructions: "Extract salient facts from the last memory-driver turns.",
        profileId: "default",
        createdBy: "hook:memory-curator",
        createdByAgentId: "ravi-dev",
        createdBySessionName: "memory-driver",
        profileInput: { agent_id: "ravi-dev", cadence: "3" },
      }),
    );
    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0]).toEqual(
      expect.objectContaining({
        taskId: "spike-task-1",
        input: expect.objectContaining({
          agentId: "curator-agent",
          sessionName: "memory-driver",
          assignedBy: "hook:memory-curator",
        }),
      }),
    );
  });

  it("dispatch_task skips dispatch when no targetAgentId is resolved", async () => {
    const created = dbCreateHook({
      name: "curator-no-target",
      eventName: "Stop",
      scopeType: "global",
      actionType: "dispatch_task",
      actionPayload: {
        profileId: "default",
        title: "Standalone curation",
      },
    });
    createdHookIds.push(created.id);

    await runHookById(created.id, {
      eventName: "Stop",
      source: "test",
      cwd: process.cwd(),
    });

    expect(createTaskCalls).toHaveLength(1);
    expect(dispatchCalls).toHaveLength(0);
  });

  it("dispatch_task does NOT create an orphan task when {{agentId}} stays unresolved", async () => {
    const created = dbCreateHook({
      name: "curator-unresolved-agent",
      eventName: "Stop",
      scopeType: "global",
      actionType: "dispatch_task",
      actionPayload: {
        profileId: "curador-memoria",
        title: "Curate memory for {{agentId}}",
        targetAgentId: "{{agentId}}",
      },
    });
    createdHookIds.push(created.id);

    // Stop event from a session with no resolvable agentId (e.g. task-*-work).
    await runHookById(created.id, {
      eventName: "Stop",
      source: "test",
      sessionName: "task-020a96f3-work",
      cwd: process.cwd(),
    });

    expect(createTaskCalls).toHaveLength(0);
    expect(dispatchCalls).toHaveLength(0);
  });

  it("anti-reentrancy: dispatch_task does NOT fire on a session name ending in -curator", async () => {
    const created = dbCreateHook({
      name: "reentry-block",
      eventName: "Stop",
      scopeType: "global",
      actionType: "dispatch_task",
      actionPayload: {
        profileId: "curador-memoria",
        title: "curate {{sessionName}}",
        targetAgentId: "ravi-dev",
      },
    });
    createdHookIds.push(created.id);

    await runHookById(created.id, {
      eventName: "Stop",
      source: "test",
      sessionName: "task-abc123-curator",
      sessionKey: "sk-curator-abc",
      agentId: "ravi-dev",
      cwd: process.cwd(),
    });

    expect(createTaskCalls).toHaveLength(0);
    expect(dispatchCalls).toHaveLength(0);
  });

  it("dispatch_task expands {{agentCwd}} and {{metadata.cadenceTurn}} in profileInputJson (auto-rollout template)", async () => {
    const { getOrCreateSession, deleteSession } = await import("../router/sessions.js");
    const sessionKey = `rollout-${Date.now()}`;
    const session = getOrCreateSession(sessionKey, "ravi-dev", "/home/ravi/ravi-dev");
    try {
      const created = dbCreateHook({
        name: "memory-curator-auto",
        eventName: "Stop",
        scopeType: "session",
        scopeValue: sessionKey,
        actionType: "dispatch_task",
        actionPayload: {
          profileId: "curador-memoria",
          title: "Curate memory for {{agentId}}",
          targetAgentId: "{{agentId}}",
          profileInputJson: JSON.stringify({
            agent_id: "{{agentId}}",
            memory_path: "{{agentCwd}}/MEMORY.md",
            memory_dir: "{{agentCwd}}/memory",
            cadence_turn: "{{metadata.cadenceTurn}}",
            originator_session: "{{sessionName}}",
          }),
          cadenceTurns: 1,
        },
      });
      createdHookIds.push(created.id);

      await runHookById(created.id, {
        eventName: "Stop",
        source: "test",
        sessionName: session.name ?? sessionKey,
        sessionKey,
        agentId: "ravi-dev",
        agentCwd: "/home/ravi/ravi-dev",
        cwd: process.cwd(),
      });

      expect(createTaskCalls).toHaveLength(1);
      expect(createTaskCalls[0]!.input.profileInput).toEqual({
        agent_id: "ravi-dev",
        memory_path: "/home/ravi/ravi-dev/MEMORY.md",
        memory_dir: "/home/ravi/ravi-dev/memory",
        cadence_turn: "1",
        originator_session: session.name ?? sessionKey,
      });
    } finally {
      deleteSession(sessionKey);
    }
  });

  it("R27: dispatch_task materializes CURATOR_TRANSCRIPT.md from the messages table, delta only", async () => {
    // Regression: transcript_path used to point at a file nobody ever wrote —
    // the curator had nothing real to read in production. The hook must now
    // pull the session's own rows from `messages` (src/db.ts, source of
    // truth) and write only what's new since the last cycle, for ANY
    // agent/session uniformly (session_id in `messages` == sessionName).
    const { getOrCreateSession, getSession, updateRuntimeProviderState, deleteSession } = await import(
      "../router/sessions.js"
    );
    const { markCurationMessageProcessed } = await import("../memory/index.js");
    const sessionKey = `sql-transcript-${Date.now()}`;
    const sessionName = sessionKey;
    const agentCwd = mkdtempSync(join(tmpdir(), "ravi-curator-transcript-"));
    getOrCreateSession(sessionKey, "ravi-dev", agentCwd);

    saveMessage(sessionName, "user", "primeira mensagem — nao deve aparecer no ciclo 2");
    saveMessage(sessionName, "assistant", "resposta 1 — nao deve aparecer no ciclo 2");

    try {
      const created = dbCreateHook({
        name: "memory-curator-sql",
        eventName: "Stop",
        scopeType: "session",
        scopeValue: sessionKey,
        actionType: "dispatch_task",
        actionPayload: {
          profileId: "curador-memoria",
          title: "Curate memory for {{agentId}}",
          targetAgentId: "{{agentId}}",
          profileInputJson: JSON.stringify({
            agent_id: "{{agentId}}",
            transcript_path: "{{agentCwd}}/CURATOR_TRANSCRIPT.md",
            since_message_id: "{{metadata.sinceMessageId}}",
          }),
          cadenceTurns: 1,
        },
      });
      createdHookIds.push(created.id);

      const eventBase = {
        eventName: "Stop" as const,
        source: "test",
        sessionName,
        sessionKey,
        agentId: "ravi-dev",
        agentCwd,
        cwd: process.cwd(),
      };

      // Cycle 1 fires (cadence 1) — reads from message id 0, i.e. everything
      // saved so far. transcript_path must exist and contain both messages.
      await runHookById(created.id, eventBase);
      const afterCycle1 = readFileSync(join(agentCwd, "CURATOR_TRANSCRIPT.md"), "utf-8");
      expect(afterCycle1).toContain("primeira mensagem");
      expect(afterCycle1).toContain("resposta 1");
      expect(createTaskCalls[0]!.input.profileInput).toEqual(expect.objectContaining({ since_message_id: "0" }));

      // Simulate what the real curator LLM does on a successful cycle: call
      // `ravi memory guard --processed-through-message-id` to advance the
      // watermark. Without this, a failed/never-completed cycle correctly
      // leaves the watermark untouched (safe fallback) — this test covers
      // the happy path where the curator DID finish.
      const sessionAfterCycle1 = getSession(sessionKey);
      expect(sessionAfterCycle1).not.toBeNull();
      const cycle1MessageIds = (afterCycle1.match(/msg#(\d+)/g) ?? []).map((m) => Number(m.replace("msg#", "")));
      const maxIdCycle1 = Math.max(...cycle1MessageIds);
      const nextParams = markCurationMessageProcessed(sessionAfterCycle1!, 1, maxIdCycle1);
      updateRuntimeProviderState(sessionKey, sessionAfterCycle1!.runtimeProvider, {
        runtimeSessionParams: nextParams,
        ...(sessionAfterCycle1!.providerSessionId ? { providerSessionId: sessionAfterCycle1!.providerSessionId } : {}),
      });

      // New turn happens between cycles.
      saveMessage(sessionName, "user", "segunda mensagem — SO esta deve aparecer no ciclo 2");
      saveMessage(sessionName, "assistant", "resposta 2 — SO esta deve aparecer no ciclo 2");

      // Cycle 2 fires — must read ONLY the delta, not the whole session.
      await runHookById(created.id, eventBase);
      const afterCycle2 = readFileSync(join(agentCwd, "CURATOR_TRANSCRIPT.md"), "utf-8");
      expect(afterCycle2).toContain("segunda mensagem");
      expect(afterCycle2).toContain("resposta 2");
      expect(afterCycle2).not.toContain("primeira mensagem");
      expect(afterCycle2).not.toContain("resposta 1");
    } finally {
      deleteSession(sessionKey);
      rmSync(agentCwd, { recursive: true, force: true });
    }
  });

  it("R1: dispatch_task with cadenceTurns fires exactly every N events on a session", async () => {
    const { getOrCreateSession, getSession, deleteSession } = await import("../router/sessions.js");
    const sessionKey = `cadence-${Date.now()}`;
    const session = getOrCreateSession(sessionKey, "ravi-dev", process.cwd());
    try {
      const created = dbCreateHook({
        name: "memory-cadence",
        eventName: "Stop",
        scopeType: "session",
        scopeValue: sessionKey,
        actionType: "dispatch_task",
        actionPayload: {
          profileId: "default",
          title: "Curate memory turn {{sessionKey}}",
          targetAgentId: "curator-agent",
          cadenceTurns: 3,
        },
      });
      createdHookIds.push(created.id);

      const eventBase = {
        eventName: "Stop" as const,
        source: "test",
        sessionName: session.name ?? sessionKey,
        sessionKey,
        agentId: "ravi-dev",
        cwd: process.cwd(),
      };

      for (let i = 0; i < 5; i += 1) {
        await runHookById(created.id, eventBase);
      }

      // Cadence 3: fires at turn 3 only (turns 1, 2, 4, 5 don't hit the boundary).
      expect(createTaskCalls).toHaveLength(1);
      expect(dispatchCalls).toHaveLength(1);

      const persisted = getSession(sessionKey);
      const curationState = persisted?.runtimeSessionParams?.memoryCuration as
        | { turnCount?: number; lastCuratedTurn?: number; cadenceTurns?: number; lastCuratedMessageId?: number }
        | undefined;
      expect(curationState).toEqual({ turnCount: 5, lastCuratedTurn: 3, cadenceTurns: 3, lastCuratedMessageId: 0 });
    } finally {
      deleteSession(sessionKey);
    }
  });

  it("R1b: dispatch_task cadence resume-aligned (state persisted before restart)", async () => {
    const { getOrCreateSession, getSession, updateRuntimeProviderState, deleteSession } = await import(
      "../router/sessions.js"
    );
    const sessionKey = `resume-${Date.now()}`;
    const session = getOrCreateSession(sessionKey, "ravi-dev", process.cwd());
    // Simulate a session persisted at turn 7 with cadence 10 (pre-restart state).
    updateRuntimeProviderState(sessionKey, session.runtimeProvider, {
      runtimeSessionParams: {
        memoryCuration: { turnCount: 7, lastCuratedTurn: 0, cadenceTurns: 10 },
      },
    });

    try {
      const created = dbCreateHook({
        name: "memory-resume",
        eventName: "Stop",
        scopeType: "session",
        scopeValue: sessionKey,
        actionType: "dispatch_task",
        actionPayload: {
          profileId: "default",
          title: "Curate on resume",
          targetAgentId: "curator-agent",
          cadenceTurns: 10,
        },
      });
      createdHookIds.push(created.id);

      const eventBase = {
        eventName: "Stop" as const,
        source: "test",
        sessionName: session.name ?? sessionKey,
        sessionKey,
        agentId: "ravi-dev",
        cwd: process.cwd(),
      };

      // Two events to reach turn 9 — should NOT fire.
      await runHookById(created.id, eventBase);
      await runHookById(created.id, eventBase);
      expect(createTaskCalls).toHaveLength(0);

      // Third event: turn 10 (not 17). R1b: cadence phase survives restart.
      await runHookById(created.id, eventBase);
      expect(createTaskCalls).toHaveLength(1);

      const persisted = getSession(sessionKey);
      const curationState = persisted?.runtimeSessionParams?.memoryCuration as
        | { turnCount?: number; lastCuratedTurn?: number }
        | undefined;
      expect(curationState?.turnCount).toBe(10);
      expect(curationState?.lastCuratedTurn).toBe(10);
    } finally {
      deleteSession(sessionKey);
    }
  });

  it("m11: dispatch_task cadence tick MUST NOT null out providerSessionId/runtimeSessionDisplayId", async () => {
    // Regression: advanceSessionCadence used to call updateRuntimeProviderState
    // with only runtimeSessionParams set. Because that helper writes
    // sdk_session_id/runtime_session_display_id unconditionally whenever
    // runtimeSessionParams is present, omitting providerSessionId zeroed the
    // provider's continuity id on every cadence tick (every 10 turns) — the
    // next turn had no id to resume from, so the runtime provider silently
    // started a fresh conversation ("loses the thread" symptom reported by RM).
    const { getOrCreateSession, getSession, updateRuntimeProviderState, deleteSession } = await import(
      "../router/sessions.js"
    );
    const sessionKey = `provider-continuity-${Date.now()}`;
    const session = getOrCreateSession(sessionKey, "ravi-dev", process.cwd());
    updateRuntimeProviderState(sessionKey, session.runtimeProvider, {
      providerSessionId: "sdk-session-must-survive-cadence",
      runtimeSessionParams: { memoryCuration: { turnCount: 0, lastCuratedTurn: 0, cadenceTurns: 2 } },
    });

    try {
      const created = dbCreateHook({
        name: "memory-provider-continuity",
        eventName: "Stop",
        scopeType: "session",
        scopeValue: sessionKey,
        actionType: "dispatch_task",
        actionPayload: {
          profileId: "default",
          title: "Curate turn {{sessionKey}}",
          targetAgentId: "curator-agent",
          cadenceTurns: 2,
        },
      });
      createdHookIds.push(created.id);

      const eventBase = {
        eventName: "Stop" as const,
        source: "test",
        sessionName: session.name ?? sessionKey,
        sessionKey,
        agentId: "ravi-dev",
        cwd: process.cwd(),
      };

      // Fires at turn 2 — the exact tick that used to null the provider id.
      await runHookById(created.id, eventBase);
      await runHookById(created.id, eventBase);
      expect(createTaskCalls).toHaveLength(1);

      const persisted = getSession(sessionKey);
      expect(persisted?.providerSessionId).toBe("sdk-session-must-survive-cadence");
    } finally {
      deleteSession(sessionKey);
    }
  });

  it("dispatch_task ignores cadence gate (falls back to always-fire) when sessionKey is absent", async () => {
    const created = dbCreateHook({
      name: "cadence-no-session",
      eventName: "Stop",
      scopeType: "global",
      actionType: "dispatch_task",
      actionPayload: {
        profileId: "default",
        title: "Fire anyway",
        cadenceTurns: 3,
      },
    });
    createdHookIds.push(created.id);

    await runHookById(created.id, {
      eventName: "Stop",
      source: "test",
      cwd: process.cwd(),
    });
    await runHookById(created.id, {
      eventName: "Stop",
      source: "test",
      cwd: process.cwd(),
    });

    expect(createTaskCalls).toHaveLength(2);
  });
});
afterAll(() => mock.restore());
