import { describe, expect, it } from "bun:test";
import {
  createQueuedRuntimeUserMessage,
  createRuntimeMessageGenerator,
  shouldInterruptRuntimeForIncoming,
} from "./delivery-queue.js";
import { shutdownRuntimeStreamingSession } from "./host-session.js";
import type { RuntimeHostStreamingSession } from "./host-session.js";
import type { RuntimeSessionHandle } from "./types.js";

function makeRuntimeSession(): RuntimeSessionHandle {
  return {
    provider: "codex",
    events: (async function* () {})(),
    interrupt: async () => {},
  };
}

function makeStreamingSession(overrides: Partial<RuntimeHostStreamingSession> = {}): RuntimeHostStreamingSession {
  return {
    agentId: "main",
    queryHandle: makeRuntimeSession(),
    starting: false,
    abortController: new AbortController(),
    pushMessage: null,
    pendingWake: false,
    pendingMessages: [],
    currentModel: "gpt-5.4",
    toolRunning: false,
    lastActivity: Date.now(),
    done: false,
    interrupted: false,
    turnActive: false,
    compacting: false,
    onTurnComplete: null,
    currentToolSafety: null,
    pendingAbort: false,
    ...overrides,
  };
}

describe("runtime delivery queue", () => {
  it("refreshes lastActivity when a new turn starts on a reused session", async () => {
    const staleActivityAt = Date.now() - 15 * 60 * 1000;
    const queuedMessage = createQueuedRuntimeUserMessage({ prompt: "continua" });
    const session = makeStreamingSession({
      pendingMessages: [queuedMessage],
      lastActivity: staleActivityAt,
    });
    const generator = createRuntimeMessageGenerator({
      sessionName: "dev",
      session,
      stashedMessages: new Map(),
    });

    const result = await generator.next();

    expect(result.done).toBe(false);
    expect(result.value).toMatchObject({
      type: "user",
      message: { role: "user", content: "continua" },
    });
    expect(session.turnActive).toBe(true);
    expect(session.lastActivity).toBeGreaterThan(staleActivityAt);

    session.done = true;
    session.onTurnComplete?.();
    await generator.return(undefined);
  });

  it("cancels idle session eviction when a new turn starts", async () => {
    const idleTimer = setTimeout(() => {}, 60_000);
    const queuedMessage = createQueuedRuntimeUserMessage({ prompt: "voltei" });
    const session = makeStreamingSession({
      pendingMessages: [queuedMessage],
      idleSessionEvictionTimer: idleTimer,
    });
    const generator = createRuntimeMessageGenerator({
      sessionName: "dev",
      session,
      stashedMessages: new Map(),
    });

    await generator.next();

    expect(session.idleSessionEvictionTimer).toBeUndefined();

    session.done = true;
    session.onTurnComplete?.();
    await generator.return(undefined);
  });

  it("clears idle session eviction timer during runtime shutdown", () => {
    const idleTimer = setTimeout(() => {}, 60_000);
    const session = makeStreamingSession({
      idleSessionEvictionTimer: idleTimer,
    });

    shutdownRuntimeStreamingSession(session, "test");

    expect(session.idleSessionEvictionTimer).toBeUndefined();
    expect(session.done).toBe(true);
  });

  it("keeps the original launch prompt envelope on queued messages", () => {
    const queuedMessage = createQueuedRuntimeUserMessage({
      prompt: "continua",
      deliveryBarrier: "after_response",
      deliveryBarrierSource: "default",
      taskBarrierTaskId: "task-1",
      source: {
        channel: "whatsapp",
        accountId: "main",
        chatId: "group:1",
        sourceMessageId: "wamid-1",
      },
      context: {
        channelId: "whatsapp",
        channelName: "WhatsApp",
        accountId: "main",
        chatId: "group:1",
        messageId: "wamid-1",
        senderId: "user-1",
        isGroup: true,
        timestamp: 1,
      },
      _agentId: "e2-filipe",
    });

    expect(queuedMessage.launchPrompt).toMatchObject({
      prompt: "continua",
      deliveryBarrier: "after_response",
      deliveryBarrierSource: "default",
      taskBarrierTaskId: "task-1",
      source: {
        channel: "whatsapp",
        accountId: "main",
        chatId: "group:1",
        sourceMessageId: "wamid-1",
      },
      context: {
        messageId: "wamid-1",
        senderId: "user-1",
      },
      _agentId: "e2-filipe",
    });
    expect(queuedMessage.deliveryBarrierSource).toBe("default");
  });

  it("does not request provider interrupt while the runtime is between turns", () => {
    const session = makeStreamingSession({
      turnActive: false,
      pushMessage: null,
      pendingMessages: [createQueuedRuntimeUserMessage({ prompt: "continua" })],
    });

    expect(shouldInterruptRuntimeForIncoming("dev", session, "after_tool")).toEqual({
      interrupt: false,
      reason: "idle_gap",
    });
  });

  it("still requests provider interrupt for active text generation", () => {
    const session = makeStreamingSession({
      turnActive: true,
      pushMessage: null,
    });

    expect(shouldInterruptRuntimeForIncoming("dev", session, "after_tool")).toEqual({
      interrupt: true,
      reason: "response",
    });
  });
});
