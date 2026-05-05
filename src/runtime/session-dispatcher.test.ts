import { describe, expect, it, mock } from "bun:test";
import type { RuntimeLaunchPrompt } from "./message-types.js";
import {
  RuntimeSessionDispatcher,
  canUseNativeRuntimeSteer,
  stashPromptForStartingSession,
} from "./session-dispatcher.js";
import type { RuntimeUserMessage } from "./host-session.js";
import type { RuntimeHostStreamingSession } from "./host-session.js";
import type { PendingRuntimeSessionStart } from "./session-launcher.js";
import { getOrCreateSession } from "../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";

function createDispatcher(maxConcurrentSessions = 10) {
  return new RuntimeSessionDispatcher({
    instanceId: "test",
    maxConcurrentSessions,
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
    expect(
      canUseNativeRuntimeSteer(
        createStreamingSession({
          queryHandle: { provider: "codex", events: (async function* () {})(), interrupt: async () => {} },
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

    expect(dispatcher.canAcceptRuntimePrompt("new-cold-start")).toBe(false);

    dispatcher.streamingSessions.set("active", createActiveSession());
    expect(dispatcher.canAcceptRuntimePrompt("active")).toBe(true);

    dispatcher.startingSessions.add("queued");
    expect(dispatcher.canAcceptRuntimePrompt("queued")).toBe(true);
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
