import { describe, expect, it, mock } from "bun:test";
import type { RuntimeLaunchPrompt } from "./message-types.js";
import {
  RuntimeSessionDispatcher,
  canUseNativeRuntimeSteer,
  stashPromptForStartingSession,
} from "./session-dispatcher.js";
import { createQueuedRuntimeUserMessage } from "./delivery-queue.js";
import { RuntimeHostSubscriptions } from "./host-subscriptions.js";
import type { RuntimeUserMessage } from "./host-session.js";
import type { RuntimeHostStreamingSession } from "./host-session.js";
import type { PendingRuntimeSessionStart } from "./session-launcher.js";
import { deleteSession, getOrCreateSession, getSessionByName, setSessionEphemeral } from "../router/sessions.js";
import {
  dbGetDaemonRestartPendingMessages,
  dbListEligibleDaemonRestartSessionSnapshots,
  dbMarkDaemonRestartResumeDelivered,
  dbRecordDaemonRestartSessionSnapshot,
  dbUpsertDaemonRestartEpoch,
} from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { querySessionTrace } from "../session-trace/query.js";
import { dbCompleteTask, dbCreateTask, dbDispatchTask } from "../tasks/task-db.js";

function createDispatcher(maxConcurrentSessions = 10, interactiveReservedSessions = 0) {
  return new RuntimeSessionDispatcher({
    instanceId: "test",
    maxConcurrentSessions,
    interactiveReservedSessions,
    safeEmit: async () => {},
    getConfigModel: () => "test-model",
  });
}

describe("RuntimeSessionDispatcher debounce", () => {
  it("preserves the latest compatible prompt envelope when combining debounced messages", async () => {
    const dispatcher = createDispatcher();
    const prompts: RuntimeLaunchPrompt[] = [];
    (
      dispatcher as unknown as { handlePromptImmediate: typeof dispatcher.handlePromptImmediate }
    ).handlePromptImmediate = mock(async (_sessionName: string, prompt: RuntimeLaunchPrompt) => {
      prompts.push(prompt);
    });

    const source = { channel: "whatsapp", accountId: "main", chatId: "group:123" };
    dispatcher.handlePromptWithDebounce(
      "session",
      {
        prompt: "primeira",
        source,
        _agentId: "agent-a",
        deliveryBarrier: "after_response",
        deliveryBarrierSource: "default",
        context: {
          channelId: "whatsapp",
          channelName: "WhatsApp",
          accountId: "main",
          chatId: "group:123",
          messageId: "m1",
          senderId: "u1",
          isGroup: true,
          timestamp: 1,
        },
      },
      60_000,
    );
    dispatcher.handlePromptWithDebounce(
      "session",
      {
        prompt: "segunda",
        source,
        _agentId: "agent-a",
        deliveryBarrier: "after_tool",
        deliveryBarrierSource: "inferred",
        context: {
          channelId: "whatsapp",
          channelName: "WhatsApp",
          accountId: "main",
          chatId: "group:123",
          messageId: "m2",
          senderId: "u2",
          isGroup: true,
          timestamp: 2,
        },
      },
      60_000,
    );

    await dispatcher.flushDebounce("session");

    expect(prompts).toHaveLength(1);
    expect(prompts[0].prompt).toBe("primeira\n\nsegunda");
    expect(prompts[0]._agentId).toBe("agent-a");
    expect(prompts[0].source).toEqual(source);
    expect(prompts[0].deliveryBarrier).toBe("after_tool");
    expect(prompts[0].deliveryBarrierSource).toBe("inferred");
    expect(prompts[0].context?.messageId).toBe("m2");
    expect(prompts[0].context?.senderId).toBe("u2");
  });

  it("does not merge task-gated prompts with normal interactive prompts", async () => {
    const dispatcher = createDispatcher();
    const prompts: RuntimeLaunchPrompt[] = [];
    (
      dispatcher as unknown as { handlePromptImmediate: typeof dispatcher.handlePromptImmediate }
    ).handlePromptImmediate = mock(async (_sessionName: string, prompt: RuntimeLaunchPrompt) => {
      prompts.push(prompt);
    });

    const source = { channel: "whatsapp", accountId: "main", chatId: "group:123" };
    dispatcher.handlePromptWithDebounce(
      "session",
      {
        prompt: "[System] Execute: faz a task",
        source,
        _agentId: "agent-a",
        deliveryBarrier: "after_task",
        taskBarrierTaskId: "task-1",
      },
      60_000,
    );
    dispatcher.handlePromptWithDebounce(
      "session",
      {
        prompt: "mensagem humana",
        source,
        _agentId: "agent-a",
        deliveryBarrier: "after_tool",
      },
      60_000,
    );

    await dispatcher.flushDebounce("session");

    expect(prompts).toHaveLength(2);
    expect(prompts[0].prompt).toBe("[System] Execute: faz a task");
    expect(prompts[0].deliveryBarrier).toBe("after_task");
    expect(prompts[0].taskBarrierTaskId).toBe("task-1");
    expect(prompts[1].prompt).toBe("mensagem humana");
    expect(prompts[1].deliveryBarrier).toBe("after_tool");
    expect(prompts[1].taskBarrierTaskId).toBeUndefined();
  });

  it("cancels debounce timers and pending starts during shutdown", async () => {
    const dispatcher = createDispatcher();
    const handlePromptImmediate = mock(async () => {});
    (
      dispatcher as unknown as { handlePromptImmediate: typeof dispatcher.handlePromptImmediate }
    ).handlePromptImmediate = handlePromptImmediate;

    dispatcher.handlePromptWithDebounce("session", { prompt: "late message" }, 5);

    let pendingResolved = false;
    const pendingStart: PendingRuntimeSessionStart = {
      sessionName: "queued",
      prompt: { prompt: "queued" },
      resolve: () => {
        pendingResolved = true;
      },
    };
    dispatcher.pendingStarts.push(pendingStart);
    dispatcher.startingSessions.add("starting");

    dispatcher.shutdownAll();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(handlePromptImmediate).not.toHaveBeenCalled();
    expect(dispatcher.debounceStates.size).toBe(0);
    expect(dispatcher.pendingStarts).toHaveLength(0);
    expect(dispatcher.startingSessions.size).toBe(0);
    expect(pendingStart.cancelled).toBe(true);
    expect(pendingResolved).toBe(true);
  });

  it("stashes prompts that arrive while a cold start is already in flight", () => {
    const stashedMessages = new Map<string, RuntimeUserMessage[]>();

    stashPromptForStartingSession(
      "session",
      {
        prompt: "primeira",
        deliveryBarrier: "after_tool",
        taskBarrierTaskId: "task-1",
      },
      stashedMessages,
    );
    expect(stashedMessages.get("session")).toHaveLength(1);

    const second = stashPromptForStartingSession(
      "session",
      {
        prompt: "segunda",
        deliveryBarrier: "after_response",
      },
      stashedMessages,
    );

    expect(second).toHaveLength(2);
    expect(second.map((message) => message.message.content)).toEqual(["primeira", "segunda"]);
    expect(second[0]?.deliveryBarrier).toBe("after_tool");
    expect(second[0]?.taskBarrierTaskId).toBe("task-1");
    expect(second[1]?.deliveryBarrier).toBe("after_response");
  });
});

describe("RuntimeSessionDispatcher native runtime steer", () => {
  function createStreamingSession(overrides: Partial<RuntimeHostStreamingSession> = {}): RuntimeHostStreamingSession {
    return {
      queryHandle: {
        provider: "pi",
        events: (async function* () {})(),
        interrupt: async () => {},
        concurrentInputStrategy: "native_steer",
        control: async () => ({ ok: true, operation: "turn.steer", state: { provider: "pi", activeTurn: true } }),
      },
      turnActive: true,
      done: false,
      starting: false,
      compacting: false,
      toolRunning: false,
      lastActivity: Date.now(),
      ...overrides,
    } as RuntimeHostStreamingSession;
  }

  it("uses native steer for active Pi after-tool prompts when the provider exposes control", () => {
    expect(canUseNativeRuntimeSteer(createStreamingSession(), "after_tool")).toBe(true);
    expect(canUseNativeRuntimeSteer(createStreamingSession(), "after_response")).toBe(false);
  });

  it("keeps Codex on the host interrupt path even when runtime control exists", () => {
    expect(
      canUseNativeRuntimeSteer(
        createStreamingSession({
          queryHandle: {
            provider: "codex",
            events: (async function* () {})(),
            interrupt: async () => {},
            concurrentInputStrategy: "interrupt",
            control: async () => ({
              ok: true,
              operation: "turn.steer",
              state: { provider: "codex", activeTurn: true },
            }),
          },
        }),
        "after_tool",
      ),
    ).toBe(false);
  });

  it("does not native steer Codex during the pre-turn queue gap", () => {
    expect(
      canUseNativeRuntimeSteer(
        createStreamingSession({
          queryHandle: {
            provider: "codex",
            events: (async function* () {})(),
            interrupt: async () => {},
            concurrentInputStrategy: "interrupt",
            control: async () => ({
              ok: true,
              operation: "turn.steer",
              state: { provider: "codex", activeTurn: false },
            }),
          },
          turnActive: false,
          pushMessage: null,
          pendingMessages: [
            { type: "user", message: { role: "user", content: "continua" }, session_id: "", parent_tool_use_id: null },
          ],
        }),
        "after_tool",
      ),
    ).toBe(false);
  });

  it("allows Pi native steer during the pre-turn queue gap instead of falling back to host concatenation", () => {
    expect(
      canUseNativeRuntimeSteer(
        createStreamingSession({
          turnActive: false,
          pushMessage: null,
          pendingMessages: [
            { type: "user", message: { role: "user", content: "primeira" }, session_id: "", parent_tool_use_id: null },
          ],
        }),
        "after_tool",
      ),
    ).toBe(true);

    expect(
      canUseNativeRuntimeSteer(
        createStreamingSession({
          turnActive: false,
          pushMessage: () => {},
          pendingMessages: [
            { type: "user", message: { role: "user", content: "primeira" }, session_id: "", parent_tool_use_id: null },
          ],
        }),
        "after_tool",
      ),
    ).toBe(false);

    expect(
      canUseNativeRuntimeSteer(
        createStreamingSession({
          turnActive: false,
          pushMessage: null,
          pendingMessages: [
            { type: "user", message: { role: "user", content: "primeira" }, session_id: "", parent_tool_use_id: null },
          ],
          currentTurnPendingIds: ["pending-1"],
        }),
        "after_tool",
      ),
    ).toBe(false);
  });

  it("does not native steer into a stale active turn", () => {
    expect(
      canUseNativeRuntimeSteer(
        createStreamingSession({
          lastActivity: Date.now() - 60_000,
        }),
        "after_tool",
      ),
    ).toBe(false);
  });

  it("does not native steer while a tool is still running", () => {
    expect(
      canUseNativeRuntimeSteer(
        createStreamingSession({
          toolRunning: true,
        }),
        "after_tool",
      ),
    ).toBe(false);
  });
});

describe("RuntimeSessionDispatcher abort resolution", () => {
  function createActiveSession(overrides: Partial<RuntimeHostStreamingSession> = {}): RuntimeHostStreamingSession {
    return {
      agentId: "dev",
      queryHandle: {
        provider: "codex",
        events: (async function* () {})(),
        interrupt: async () => {},
      },
      abortController: new AbortController(),
      pendingMessages: [],
      currentModel: "test-model",
      toolRunning: false,
      lastActivity: Date.now(),
      done: false,
      starting: false,
      compacting: false,
      interrupted: false,
      turnActive: false,
      pushMessage: null,
      pendingWake: false,
      onTurnComplete: null,
      currentToolSafety: null,
      pendingAbort: false,
      ...overrides,
    };
  }

  it("keeps new cold starts behind already queued runtime session starts", () => {
    const dispatcher = createDispatcher(2);
    dispatcher.pendingStarts.push({
      sessionName: "queued",
      prompt: { prompt: "queued" },
      resolve: () => {},
    });

    dispatcher.streamingSessions.set("first", createActiveSession());
    dispatcher.streamingSessions.set("active", createActiveSession());
    expect(dispatcher.canAcceptRuntimePrompt("new-cold-start")).toBe(false);

    expect(dispatcher.canAcceptRuntimePrompt("active")).toBe(true);

    dispatcher.pendingStartSessions.add("queued");
    expect(dispatcher.canAcceptRuntimePrompt("queued")).toBe(true);
  });

  it("records daemon restart snapshots for non-idle runtime sessions with pending work", async () => {
    const stateDir = await createIsolatedRaviState("ravi-runtime-dispatcher-restart-snapshot-");
    try {
      const now = Date.now();
      getOrCreateSession("agent:dev:test:restart-active", "dev", stateDir, { name: "restart-active" });
      getOrCreateSession("agent:dev:test:restart-idle", "dev", stateDir, { name: "restart-idle" });
      dbUpsertDaemonRestartEpoch({ restartEpoch: "epoch-active", reason: "test", createdAt: now });

      const dispatcher = createDispatcher(2);
      dispatcher.streamingSessions.set(
        "restart-active",
        createActiveSession({
          turnActive: true,
          lastActivity: now - 1_000,
          pendingMessages: [
            createQueuedRuntimeUserMessage({
              prompt: "queued user work",
              deliveryBarrier: "after_response",
            }),
          ],
        }),
      );
      dispatcher.streamingSessions.set(
        "restart-idle",
        createActiveSession({
          turnActive: false,
          lastActivity: now - 1_000,
          pendingMessages: [],
        }),
      );

      expect(
        dispatcher.recordDaemonRestartSnapshot({
          restartEpoch: "epoch-active",
          reason: "test",
          stoppedAt: now,
        }),
      ).toBe(1);

      const eligible = dbListEligibleDaemonRestartSessionSnapshots({
        restartEpoch: "epoch-active",
        now: now + 1_000,
      });
      expect(eligible.map((snapshot) => snapshot.sessionName)).toEqual(["restart-active"]);
      expect(eligible[0]?.pendingMessageCount).toBe(1);

      const pending = dbGetDaemonRestartPendingMessages("epoch-active", "agent:dev:test:restart-active");
      expect((pending[0] as RuntimeUserMessage | undefined)?.message.content).toBe("queued user work");
    } finally {
      await cleanupIsolatedRaviState(stateDir);
    }
  });

  it("does not record daemon restart snapshots for terminal task sessions", async () => {
    const stateDir = await createIsolatedRaviState("ravi-runtime-dispatcher-restart-terminal-task-");
    try {
      const now = Date.now();
      const created = dbCreateTask({
        title: "terminal task restart",
        instructions: "must not resume after done",
        createdBy: "test",
        createdByAgentId: "dev",
        createdBySessionName: "dev",
      });
      const sessionName = `${created.task.id}-work`;
      getOrCreateSession(`agent:dev:${sessionName}`, "dev", stateDir, { name: sessionName });
      dbDispatchTask(created.task.id, {
        agentId: "dev",
        sessionName,
        assignedBy: "test",
      });
      dbCompleteTask(created.task.id, {
        actor: "test",
        agentId: "dev",
        sessionName,
        message: "done",
      });
      dbUpsertDaemonRestartEpoch({ restartEpoch: "epoch-terminal-task", reason: "test", createdAt: now });

      const dispatcher = createDispatcher(2);
      dispatcher.streamingSessions.set(
        sessionName,
        createActiveSession({
          turnActive: true,
          lastActivity: now - 1_000,
          currentTaskBarrierTaskId: created.task.id,
        }),
      );

      expect(
        dispatcher.recordDaemonRestartSnapshot({
          restartEpoch: "epoch-terminal-task",
          reason: "test",
          stoppedAt: now,
        }),
      ).toBe(0);
      expect(
        dbListEligibleDaemonRestartSessionSnapshots({
          restartEpoch: "epoch-terminal-task",
          now: now + 1_000,
        }),
      ).toEqual([]);
    } finally {
      await cleanupIsolatedRaviState(stateDir);
    }
  });

  it("enforces daemon restart resume window and delivery idempotency", async () => {
    const stateDir = await createIsolatedRaviState("ravi-runtime-dispatcher-restart-eligibility-");
    try {
      const now = Date.now();
      getOrCreateSession("agent:dev:test:restart-fresh", "dev", stateDir, { name: "restart-fresh" });
      getOrCreateSession("agent:dev:test:restart-stale", "dev", stateDir, { name: "restart-stale" });
      dbUpsertDaemonRestartEpoch({ restartEpoch: "epoch-window", reason: "test", createdAt: now });

      dbRecordDaemonRestartSessionSnapshot({
        restartEpoch: "epoch-window",
        sessionKey: "agent:dev:test:restart-fresh",
        sessionName: "restart-fresh",
        agentId: "dev",
        runtimeProvider: "codex",
        activity: "thinking",
        nonIdle: true,
        lastActivityAt: now - 1_000,
        stoppedAt: now - 1_000,
      });
      dbRecordDaemonRestartSessionSnapshot({
        restartEpoch: "epoch-window",
        sessionKey: "agent:dev:test:restart-stale",
        sessionName: "restart-stale",
        agentId: "dev",
        runtimeProvider: "codex",
        activity: "thinking",
        nonIdle: true,
        lastActivityAt: now - 2 * 60 * 60 * 1000,
        stoppedAt: now - 2 * 60 * 60 * 1000,
      });

      expect(
        dbListEligibleDaemonRestartSessionSnapshots({
          restartEpoch: "epoch-window",
          now,
          windowMs: 60 * 60 * 1000,
        }).map((snapshot) => snapshot.sessionName),
      ).toEqual(["restart-fresh"]);

      expect(
        dbMarkDaemonRestartResumeDelivered({
          restartEpoch: "epoch-window",
          sessionKey: "agent:dev:test:restart-fresh",
          sessionName: "restart-fresh",
          deliveredAt: now,
        }),
      ).toBe(true);
      expect(
        dbMarkDaemonRestartResumeDelivered({
          restartEpoch: "epoch-window",
          sessionKey: "agent:dev:test:restart-fresh",
          sessionName: "restart-fresh",
          deliveredAt: now,
        }),
      ).toBe(false);
      expect(
        dbListEligibleDaemonRestartSessionSnapshots({
          restartEpoch: "epoch-window",
          now,
          windowMs: 60 * 60 * 1000,
        }),
      ).toHaveLength(0);
    } finally {
      await cleanupIsolatedRaviState(stateDir);
    }
  });

  it("keeps pending pool starts separate from actual cold starts and traces the canonical session key", async () => {
    const stateDir = await createIsolatedRaviState("ravi-runtime-dispatcher-pending-start-");
    try {
      getOrCreateSession("agent:dev:test:pending-start", "dev", stateDir, { name: "pending-start-by-name" });
      const dispatcher = createDispatcher(1);
      dispatcher.streamingSessions.set("active", createActiveSession());

      const firstStart = dispatcher.handlePromptImmediate("pending-start-by-name", {
        prompt: "first",
        source: {
          channel: "whatsapp",
          accountId: "main",
          chatId: "group:123",
          sourceMessageId: "m1",
          actorType: "contact",
        },
        context: {
          channelId: "whatsapp",
          channelName: "WhatsApp",
          accountId: "main",
          chatId: "group:123",
          messageId: "m1",
          senderId: "u1",
          isGroup: true,
          timestamp: Date.now(),
          actorType: "contact",
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(dispatcher.pendingStarts).toHaveLength(1);
      expect(dispatcher.pendingStartSessions.has("pending-start-by-name")).toBe(true);
      expect(dispatcher.startingSessions.has("pending-start-by-name")).toBe(false);

      await dispatcher.handlePromptImmediate("pending-start-by-name", {
        prompt: "second",
        source: {
          channel: "whatsapp",
          accountId: "main",
          chatId: "group:123",
          sourceMessageId: "m2",
          actorType: "contact",
        },
        context: {
          channelId: "whatsapp",
          channelName: "WhatsApp",
          accountId: "main",
          chatId: "group:123",
          messageId: "m2",
          senderId: "u1",
          isGroup: true,
          timestamp: Date.now(),
          actorType: "contact",
        },
      });

      expect(dispatcher.stashedMessages.get("pending-start-by-name")).toHaveLength(1);

      const trace = querySessionTrace({
        sessionKey: "agent:dev:test:pending-start",
        sessionName: "pending-start-by-name",
        only: "dispatch",
      });
      const queued = trace.events.filter((event) => event.eventType === "dispatch.queued_busy");
      expect(queued.map((event) => event.sessionKey)).toEqual([
        "agent:dev:test:pending-start",
        "agent:dev:test:pending-start",
      ]);
      expect(queued.map((event) => (event.payloadJson as { reason?: string } | null)?.reason)).toEqual([
        "concurrency_limit",
        "pending_start_backpressure",
      ]);

      dispatcher.shutdownAll();
      await firstStart;
    } finally {
      await cleanupIsolatedRaviState(stateDir);
    }
  });

  it("reserves pool capacity for interactive starts over background task starts", () => {
    const dispatcher = createDispatcher(3, 1);
    dispatcher.streamingSessions.set("task-one-work", createActiveSession());
    dispatcher.streamingSessions.set("task-two-work", createActiveSession());

    expect(dispatcher.canAcceptRuntimePrompt("task-three-work")).toBe(false);
    expect(dispatcher.canAcceptRuntimePrompt("main:group:123")).toBe(true);
  });

  it("aborts a live runtime session by session key when the pool is keyed by session name", async () => {
    const stateDir = await createIsolatedRaviState("ravi-runtime-dispatcher-abort-");
    try {
      getOrCreateSession("agent:dev:test:abort-key", "dev", stateDir, { name: "abort-by-name" });
      const dispatcher = createDispatcher(1);
      let interrupted = false;
      let pendingResolved = false;
      let secondPendingResolved = false;
      dispatcher.pendingStarts.push({
        sessionName: "queued-after-abort",
        prompt: { prompt: "queued" },
        resolve: () => {
          pendingResolved = true;
        },
      });
      dispatcher.pendingStarts.push({
        sessionName: "second-queued-after-abort",
        prompt: { prompt: "second queued" },
        resolve: () => {
          secondPendingResolved = true;
        },
      });
      dispatcher.streamingSessions.set(
        "abort-by-name",
        createActiveSession({
          queryHandle: {
            provider: "codex",
            events: (async function* () {})(),
            interrupt: async () => {
              interrupted = true;
            },
          },
        }),
      );

      expect(dispatcher.abortSession({ sessionKey: "agent:dev:test:abort-key" }, { reason: "test_abort" })).toBe(true);
      expect(dispatcher.streamingSessions.has("abort-by-name")).toBe(false);
      expect(interrupted).toBe(true);
      expect(pendingResolved).toBe(true);
      expect(secondPendingResolved).toBe(false);
      expect(dispatcher.pendingStarts).toHaveLength(1);
      expect(dispatcher.startReservations.has("queued-after-abort")).toBe(true);
      expect(dispatcher.canAcceptRuntimePrompt("fresh-cold-start")).toBe(false);

      dispatcher.drainPendingStarts();
      expect(secondPendingResolved).toBe(false);
      expect(dispatcher.pendingStarts).toHaveLength(1);
    } finally {
      await cleanupIsolatedRaviState(stateDir);
    }
  });

  it("drains queued runtime starts when an external model change restarts a live session", async () => {
    const stateDir = await createIsolatedRaviState("ravi-runtime-dispatcher-model-change-");
    try {
      getOrCreateSession("agent:dev:test:model-change", "dev", stateDir, { name: "model-change-by-name" });
      const dispatcher = createDispatcher(1);
      let pendingResolved = false;
      dispatcher.pendingStarts.push({
        sessionName: "queued-after-model-change",
        prompt: { prompt: "queued" },
        resolve: () => {
          pendingResolved = true;
        },
      });
      dispatcher.streamingSessions.set("model-change-by-name", createActiveSession());

      const result = await dispatcher.applySessionModelChange("model-change-by-name", "next-model");

      expect(result).toBe("restart-next-turn");
      expect(dispatcher.streamingSessions.has("model-change-by-name")).toBe(false);
      expect(pendingResolved).toBe(true);
      expect(dispatcher.pendingStarts).toHaveLength(0);
    } finally {
      await cleanupIsolatedRaviState(stateDir);
    }
  });

  it("releases task runtime sessions when task terminal events are emitted", async () => {
    const dispatcher = createDispatcher(1);
    let interrupted = false;
    let pendingResolved = false;
    dispatcher.streamingSessions.set(
      "task-release-work",
      createActiveSession({
        queryHandle: {
          provider: "codex",
          events: (async function* () {})(),
          interrupt: async () => {
            interrupted = true;
          },
        },
      }),
    );
    dispatcher.pendingStarts.push({
      sessionName: "queued-after-task-release",
      prompt: { prompt: "queued" },
      resolve: () => {
        pendingResolved = true;
      },
    });

    const runtime = new RuntimeHostSubscriptions({
      isRunning: () => true,
      dispatcher,
      safeEmit: async () => {},
    });

    await runtime.handleTaskEventForRuntime({
      taskId: "task-release",
      assigneeSessionName: "task-release-work",
      event: { id: 42, type: "task.done", sessionName: "main" },
    });

    expect(dispatcher.streamingSessions.has("task-release-work")).toBe(false);
    expect(interrupted).toBe(true);
    expect(pendingResolved).toBe(true);
    expect(dispatcher.pendingStarts).toHaveLength(0);
  });

  it("deletes ephemeral task-work sessions from DB on task terminal events", async () => {
    const stateDir = await createIsolatedRaviState("ravi-runtime-zombie-task-work-");
    try {
      const sessionName = "task-zombie-fix-work";
      const entry = getOrCreateSession("agent:dev:test:zombie-fix", "dev", stateDir, { name: sessionName });
      setSessionEphemeral(entry.sessionKey, 24 * 60 * 60_000);
      expect(getSessionByName(sessionName)?.ephemeral).toBe(true);

      const dispatcher = createDispatcher(1);
      const runtime = new RuntimeHostSubscriptions({
        isRunning: () => true,
        dispatcher,
        safeEmit: async () => {},
      });

      await runtime.handleTaskEventForRuntime({
        taskId: "task-zombie-fix",
        assigneeSessionName: sessionName,
        event: { id: 7, type: "task.done", sessionName: "main" },
      });

      expect(getSessionByName(sessionName)).toBeNull();
    } finally {
      await cleanupIsolatedRaviState(stateDir);
    }
  });

  it("does not delete non-ephemeral task-work sessions on terminal events", async () => {
    const stateDir = await createIsolatedRaviState("ravi-runtime-zombie-task-work-permanent-");
    try {
      const sessionName = "task-permanent-work";
      const entry = getOrCreateSession("agent:dev:test:permanent", "dev", stateDir, { name: sessionName });
      // Do NOT call setSessionEphemeral — session stays permanent
      expect(getSessionByName(sessionName)?.ephemeral).toBeFalsy();

      const dispatcher = createDispatcher(1);
      const runtime = new RuntimeHostSubscriptions({
        isRunning: () => true,
        dispatcher,
        safeEmit: async () => {},
      });

      await runtime.handleTaskEventForRuntime({
        taskId: "task-permanent",
        assigneeSessionName: sessionName,
        event: { id: 8, type: "task.done", sessionName: "main" },
      });

      expect(getSessionByName(sessionName)?.sessionKey).toBe(entry.sessionKey);
      deleteSession(entry.sessionKey);
    } finally {
      await cleanupIsolatedRaviState(stateDir);
    }
  });

  it("releases blocked task runtime sessions without aborting normal sessions", async () => {
    const dispatcher = createDispatcher(2);
    dispatcher.streamingSessions.set("task-blocked-work", createActiveSession());
    dispatcher.streamingSessions.set("main", createActiveSession());

    const runtime = new RuntimeHostSubscriptions({
      isRunning: () => true,
      dispatcher,
      safeEmit: async () => {},
    });

    await runtime.handleTaskEventForRuntime({
      taskId: "task-blocked",
      assigneeSessionName: "task-blocked-work",
      event: { type: "task.blocked", sessionName: "main" },
    });
    await runtime.handleTaskEventForRuntime({
      taskId: "task-human",
      assigneeSessionName: "main",
      event: { type: "task.done", sessionName: "main" },
    });

    expect(dispatcher.streamingSessions.has("task-blocked-work")).toBe(false);
    expect(dispatcher.streamingSessions.has("main")).toBe(true);
  });

  it("keeps queued runtime starts parked when model change caller immediately restarts the same session", async () => {
    const stateDir = await createIsolatedRaviState("ravi-runtime-dispatcher-inline-model-change-");
    try {
      getOrCreateSession("agent:dev:test:inline-model-change", "dev", stateDir, { name: "inline-model-change" });
      const dispatcher = createDispatcher(1);
      let pendingResolved = false;
      dispatcher.pendingStarts.push({
        sessionName: "queued-after-inline-model-change",
        prompt: { prompt: "queued" },
        resolve: () => {
          pendingResolved = true;
        },
      });
      dispatcher.streamingSessions.set("inline-model-change", createActiveSession());

      const result = await dispatcher.applySessionModelChange("inline-model-change", "next-model", {
        drainReleasedSlot: false,
      });

      expect(result).toBe("restart-next-turn");
      expect(dispatcher.streamingSessions.has("inline-model-change")).toBe(false);
      expect(pendingResolved).toBe(false);
      expect(dispatcher.pendingStarts).toHaveLength(1);
    } finally {
      await cleanupIsolatedRaviState(stateDir);
    }
  });
});
