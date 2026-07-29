import { describe, expect, it } from "bun:test";
import {
  createQueuedRuntimeUserMessage,
  createRuntimeMessageGenerator,
  getDeliverableRuntimeMessages,
  shouldInterruptRuntimeForIncoming,
} from "./delivery-queue.js";
import { shutdownRuntimeStreamingSession } from "./host-session.js";
import type { RuntimeHostStreamingSession } from "./host-session.js";
import { buildSessionRelayTurnOrigin } from "./turn-origin.js";
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

  it("delivers at most one channel backend message in a local runtime turn", () => {
    const first = createQueuedRuntimeUserMessage(channelPrompt("first", "turn-a"));
    const second = createQueuedRuntimeUserMessage(channelPrompt("second", "turn-b"));
    const session = makeStreamingSession({
      pendingMessages: [first, second],
    });

    expect(getDeliverableRuntimeMessages("dev", session)).toEqual([first]);
  });

  it("preserves normal message batching boundaries around channel backend turns", () => {
    const normalBefore = createQueuedRuntimeUserMessage({ prompt: "normal before" });
    const backend = createQueuedRuntimeUserMessage(channelPrompt("backend", "turn-a"));
    const normalAfter = createQueuedRuntimeUserMessage({ prompt: "normal after" });
    const session = makeStreamingSession({
      pendingMessages: [normalBefore, backend, normalAfter],
    });

    expect(getDeliverableRuntimeMessages("dev", session)).toEqual([normalBefore]);

    session.pendingMessages.shift();
    expect(getDeliverableRuntimeMessages("dev", session)).toEqual([backend]);

    session.pendingMessages.shift();
    expect(getDeliverableRuntimeMessages("dev", session)).toEqual([normalAfter]);
  });

  it("isolates typed internal origins from surrounding external messages", () => {
    const externalBefore = createQueuedRuntimeUserMessage({ prompt: "external before" });
    const internal = createQueuedRuntimeUserMessage({
      prompt: "internal",
      _turnOrigin: buildSessionRelayTurnOrigin("inform", {
        agentId: "origin-agent",
        sessionKey: "agent:origin-agent:main",
      }),
    });
    const externalAfter = createQueuedRuntimeUserMessage({ prompt: "external after" });
    const session = makeStreamingSession({
      pendingMessages: [externalBefore, internal, externalAfter],
    });

    expect(getDeliverableRuntimeMessages("dev", session)).toEqual([externalBefore]);

    session.pendingMessages.shift();
    expect(getDeliverableRuntimeMessages("dev", session)).toEqual([internal]);

    session.pendingMessages.shift();
    expect(getDeliverableRuntimeMessages("dev", session)).toEqual([externalAfter]);
  });
});

function channelPrompt(prompt: string, turnId: string) {
  return {
    prompt,
    _channelBackend: {
      protocol: "ravi.channel.backend" as const,
      schemaVersion: 1 as const,
      ingressRequestId: `request-${turnId}`,
      correlationId: `correlation-${turnId}`,
      binding: {
        channelInstanceId: "channel-instance-a",
        agentId: "agent-a",
        chatId: "chat-a",
        messageId: `message-${turnId}`,
        sessionId: "session-a",
        turnId,
      },
      target: {
        channelKind: "custom",
        connectionId: "connection-a",
        conversationId: "conversation-a",
      },
    },
  };
}
