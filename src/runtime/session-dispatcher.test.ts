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

function createDispatcher() {
  return new RuntimeSessionDispatcher({
    instanceId: "test",
    maxConcurrentSessions: 10,
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
});
