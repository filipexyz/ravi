import { describe, expect, it } from "bun:test";
import {
  canReleaseRuntimeDeliveryBarrier,
  createQueuedRuntimeUserMessage,
  createRuntimeMessageGenerator,
  getDeliverableRuntimeMessages,
  prepareRuntimeInterruptSuccessor,
  shouldInterruptRuntimeForIncoming,
} from "./delivery-queue.js";
import {
  resolveRuntimeToolEffectFence,
  shutdownRuntimeStreamingSession,
  stashCurrentTurnRuntimeMessages,
  stashPendingRuntimeMessages,
} from "./host-session.js";
import type { RuntimeHostStreamingSession, RuntimeUserMessage } from "./host-session.js";
import type { RuntimeCrashRecoveryCoordinator } from "./crash-recovery.js";
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
  it("distinguishes host write-ahead from Codex and Pi asynchronous tool observation", () => {
    expect(resolveRuntimeToolEffectFence("claude", "ravi-host")).toBe("host_write_ahead");
    expect(resolveRuntimeToolEffectFence("codex", "ravi-host")).toBe("provider_event_only");
    expect(resolveRuntimeToolEffectFence("pi", "provider-native")).toBe("provider_event_only");
  });

  it("refreshes lastActivity when a new turn starts on a reused session", async () => {
    const staleActivityAt = Date.now() - 15 * 60 * 1000;
    const queuedMessage = createQueuedRuntimeUserMessage({ prompt: "continua" });
    const session = makeStreamingSession({
      pendingMessages: [queuedMessage],
      lastActivity: staleActivityAt,
      durableTurnPreparationFailed: true,
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
    expect(session.durableTurnPreparationFailed).toBe(false);
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

  it("fails closed before provider delivery when durable turn preparation fails", async () => {
    const queuedMessage = createQueuedRuntimeUserMessage({ prompt: "must stay durable" });
    const session = makeStreamingSession({
      pendingMessages: [queuedMessage],
      currentCrashRecoveryAttemptId: "stale-attempt",
    });
    const generator = createRuntimeMessageGenerator({
      sessionName: "dev",
      session,
      stashedMessages: new Map(),
      traceTurnStart: () => {
        throw new Error("ledger unavailable");
      },
    });

    await expect(generator.next()).rejects.toThrow("ledger unavailable");
    expect(session.pendingMessages).toEqual([queuedMessage]);
    expect(session.turnActive).toBe(false);
    expect(session.currentTurnPendingIds).toBeUndefined();
    expect(session.currentTraceTurnId).toBeUndefined();
    expect(session.currentCrashRecoveryAttemptId).toBeUndefined();
    expect(session.durableTurnPreparationFailed).toBe(true);
    expect(session.onTurnComplete).toBeNull();
  });

  it("retains a terminal latch until the next physical handoff begins", async () => {
    const active = createQueuedRuntimeUserMessage({ prompt: "already complete" });
    const successor = createQueuedRuntimeUserMessage({ prompt: "next turn" });
    const session = makeStreamingSession({ pendingMessages: [active] });
    const generator = createRuntimeMessageGenerator({
      sessionName: "dev",
      session,
      stashedMessages: new Map(),
    });

    expect((await generator.next()).value).toMatchObject({
      message: { content: "already complete" },
    });
    session.pendingMessages.push(successor);
    session.currentCrashRecoveryTerminal = {
      status: "complete",
      completedAt: Date.now(),
      startedTool: false,
      materializedOutput: false,
    };

    const nextTurn = generator.next();
    session.onTurnComplete?.();

    // Snapshot code may run synchronously in this exact terminal->drain gap.
    expect(session.currentCrashRecoveryTerminal?.status).toBe("complete");
    expect((await nextTurn).value).toMatchObject({
      message: { content: "next turn" },
    });
    expect(session.currentCrashRecoveryTerminal).toBeUndefined();

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

  it("keeps every interrupt lane closed while a provider tool callback is being delivered", () => {
    const session = makeStreamingSession({
      turnActive: true,
      toolRunning: false,
      currentToolSafety: "safe",
      toolResultDeliveryPending: true,
    });

    for (const barrier of ["immediate_interrupt", "after_tool", "after_response", "after_task"] as const) {
      expect(canReleaseRuntimeDeliveryBarrier("dev", session, barrier, undefined, false)).toBe(false);
    }
    expect(shouldInterruptRuntimeForIncoming("dev", session, "immediate_interrupt")).toEqual({
      interrupt: false,
      reason: "tool_result_delivery",
    });
    expect(shouldInterruptRuntimeForIncoming("dev", session, "after_tool")).toEqual({
      interrupt: false,
      reason: "tool_result_delivery",
    });
  });

  it("delivers the steering prompt next instead of replaying the superseded channel turn", async () => {
    const active = createQueuedRuntimeUserMessage(channelPrompt("implement the old plan", "turn-a"));
    const steering = createQueuedRuntimeUserMessage(channelPrompt("stop and use the new plan", "turn-b"));
    const session = makeStreamingSession({
      pendingMessages: [active],
    });
    const generator = createRuntimeMessageGenerator({
      sessionName: "dev",
      session,
      stashedMessages: new Map(),
    });

    const first = await generator.next();
    expect(first.value).toMatchObject({
      message: { content: "implement the old plan" },
    });

    session.pendingMessages.push(steering);
    session.currentTurnSuperseded = true;
    session.interrupted = true;
    session.turnActive = false;
    session.onTurnComplete?.();

    const second = await generator.next();
    expect(second.value).toMatchObject({
      message: { content: "stop and use the new plan" },
    });
    expect(session.pendingMessages).toEqual([steering]);

    session.done = true;
    session.onTurnComplete?.();
    await generator.return(undefined);
  });

  it("coalesces a compatible channel backlog behind the latest interrupting prompt", async () => {
    const active = createQueuedRuntimeUserMessage(channelPrompt("old active work", "turn-a"));
    const queued = createQueuedRuntimeUserMessage(channelPrompt("first steering detail", "turn-b"));
    const latest = createQueuedRuntimeUserMessage(channelPrompt("latest steering direction", "turn-c"));
    const session = makeStreamingSession({ pendingMessages: [active] });
    const generator = createRuntimeMessageGenerator({
      sessionName: "dev",
      session,
      stashedMessages: new Map(),
    });

    expect((await generator.next()).value).toMatchObject({
      message: { content: "old active work" },
    });
    session.pendingMessages.push(queued, latest);

    const prepared = prepareRuntimeInterruptSuccessor("dev", session);

    expect(prepared?.coalescedMessages).toEqual([queued]);
    expect(session.pendingMessages).toHaveLength(2);
    expect(session.pendingMessages[0]).toBe(active);
    expect(session.pendingMessages[1]).toMatchObject({
      pendingId: latest.pendingId,
      message: { content: "first steering detail\n\nlatest steering direction" },
      launchPrompt: {
        prompt: "first steering detail\n\nlatest steering direction",
        _channelBackend: { binding: { turnId: "turn-c" } },
      },
    });

    session.currentTurnSuperseded = true;
    session.interrupted = true;
    session.turnActive = false;
    session.onTurnComplete?.();

    expect((await generator.next()).value).toMatchObject({
      message: { content: "first steering detail\n\nlatest steering direction" },
    });

    session.done = true;
    session.onTurnComplete?.();
    await generator.return(undefined);
  });

  it("preserves FIFO instead of combining or reordering different actors", () => {
    const active = createQueuedRuntimeUserMessage(channelPrompt("active", "turn-a"));
    const otherActor = createQueuedRuntimeUserMessage(channelPrompt("other actor", "turn-b", "user-b"));
    const latest = createQueuedRuntimeUserMessage(channelPrompt("latest", "turn-c", "user-a"));
    const session = makeStreamingSession({
      turnActive: true,
      pendingMessages: [active, otherActor, latest],
      currentTurnPendingIds: [active.pendingId!],
    });

    const prepared = prepareRuntimeInterruptSuccessor("dev", session);

    expect(prepared?.coalescedMessages).toEqual([]);
    expect(prepared?.message).toBe(otherActor);
    expect(session.pendingMessages.map((message) => message.message.content)).toEqual([
      "active",
      "other actor",
      "latest",
    ]);
  });

  it("keeps steering prompts from different channel threads isolated", () => {
    const active = createQueuedRuntimeUserMessage(channelPrompt("active", "turn-a"));
    const firstThread = createQueuedRuntimeUserMessage(channelPrompt("thread one", "turn-b", "user-a", "thread-1"));
    const secondThread = createQueuedRuntimeUserMessage(channelPrompt("thread two", "turn-c", "user-a", "thread-2"));
    const session = makeStreamingSession({
      turnActive: true,
      pendingMessages: [active, firstThread, secondThread],
      currentTurnPendingIds: [active.pendingId!],
    });

    const prepared = prepareRuntimeInterruptSuccessor("dev", session);

    expect(prepared?.coalescedMessages).toEqual([]);
    expect(prepared?.message).toBe(firstThread);
    expect(session.pendingMessages).toEqual([active, firstThread, secondThread]);
  });

  it("does not fold Ravi Commands into conversational steering", () => {
    const active = createQueuedRuntimeUserMessage(channelPrompt("active", "turn-a"));
    const command = createQueuedRuntimeUserMessage({
      ...channelPrompt("#deploy", "turn-b"),
      commands: [
        {
          id: "deploy",
          scope: "agent",
          sourcePath: "/commands/deploy.md",
          originalText: "#deploy",
          arguments: "",
          renderedPromptSha256: "a".repeat(64),
        },
      ],
    });
    const steering = createQueuedRuntimeUserMessage(channelPrompt("after command", "turn-c"));
    const session = makeStreamingSession({
      turnActive: true,
      pendingMessages: [active, command, steering],
      currentTurnPendingIds: [active.pendingId!],
    });

    const prepared = prepareRuntimeInterruptSuccessor("dev", session);

    expect(prepared?.coalescedMessages).toEqual([]);
    expect(prepared?.message).toBe(command);
    expect(session.pendingMessages).toEqual([active, command, steering]);
  });

  it("replays an active prompt marked for provider reconciliation", async () => {
    const active = createQueuedRuntimeUserMessage(channelPrompt("keep this work", "turn-a"));
    const session = makeStreamingSession({
      pendingMessages: [active],
    });
    const generator = createRuntimeMessageGenerator({
      sessionName: "dev",
      session,
      stashedMessages: new Map(),
    });

    const first = await generator.next();
    expect(first.value).toMatchObject({
      clientMessageId: expect.stringContaining("ravi:"),
      replay: false,
    });
    active.replay = true;
    session.interrupted = true;
    session.turnActive = false;
    session.onTurnComplete?.();

    const replay = await generator.next();
    expect(replay.value).toMatchObject({
      message: { content: "keep this work" },
      clientMessageId: first.value?.clientMessageId,
      replay: true,
    });
    expect(session.pendingMessages).toEqual([active]);

    session.done = true;
    session.onTurnComplete?.();
    await generator.return(undefined);
  });

  it("keeps later messages out of a stashed delivery attempt", () => {
    const active = createQueuedRuntimeUserMessage({ prompt: "original" });
    active.clientMessageId = "ravi:original";
    active.replay = true;
    const later = createQueuedRuntimeUserMessage({ prompt: "later" });
    const session = makeStreamingSession({
      pendingMessages: [active, later],
    });

    expect(getDeliverableRuntimeMessages("dev", session)).toEqual([active]);
  });

  it("keeps a prior delivery attempt out of a fresh unassigned batch", () => {
    const fresh = createQueuedRuntimeUserMessage({ prompt: "fresh" });
    const priorAttempt = createQueuedRuntimeUserMessage({ prompt: "prior attempt" });
    priorAttempt.clientMessageId = "ravi:prior";
    priorAttempt.replay = true;
    const session = makeStreamingSession({
      pendingMessages: [fresh, priorAttempt],
    });

    expect(getDeliverableRuntimeMessages("dev", session)).toEqual([fresh]);
  });

  it("keeps intentional restarts mergeable even when the old turn had a delivery id", () => {
    const active = createQueuedRuntimeUserMessage({ prompt: "original" });
    active.clientMessageId = "ravi:original";
    const later = createQueuedRuntimeUserMessage({ prompt: "later" });
    const session = makeStreamingSession({
      pendingMessages: [active, later],
    });

    expect(getDeliverableRuntimeMessages("dev", session)).toEqual([active, later]);
  });

  it("marks only the active delivery as ambiguous when stashing inactivity recovery", () => {
    const active = createQueuedRuntimeUserMessage({ prompt: "active" });
    const later = createQueuedRuntimeUserMessage({ prompt: "later" });
    const session = makeStreamingSession({
      pendingMessages: [active, later],
      currentTurnPendingIds: [active.pendingId!],
    });
    const stash = new Map<string, RuntimeUserMessage[]>();

    stashPendingRuntimeMessages("dev", session, stash, { reconcileCurrentTurn: true });

    expect(stash.get("dev")?.map((message) => message.replay)).toEqual([true, undefined]);
    expect(stash.get("dev")?.[0]?.terminalReplayAllowed).toBe(true);
  });

  it("stashes only the successor when an interrupted turn was intentionally superseded", () => {
    const active = createQueuedRuntimeUserMessage(channelPrompt("old work", "turn-a"));
    const steering = createQueuedRuntimeUserMessage(channelPrompt("new direction", "turn-b"));
    const session = makeStreamingSession({
      pendingMessages: [active, steering],
      currentTurnPendingIds: [active.pendingId!],
      currentTurnSuperseded: true,
    });
    const pendingStash = new Map();
    const currentTurnStash = new Map();

    stashPendingRuntimeMessages("dev", session, pendingStash);
    expect(pendingStash.get("dev")).toEqual([steering]);
    expect(stashCurrentTurnRuntimeMessages("dev", session, currentTurnStash)).toBe(1);
    expect(currentTurnStash.get("dev")).toEqual([steering]);
  });

  it("does not replay a provider-native current turn before its asynchronous tool event can arrive", () => {
    const active = createQueuedRuntimeUserMessage(channelPrompt("may already have run a tool", "turn-a"));
    const successor = createQueuedRuntimeUserMessage(channelPrompt("independent successor", "turn-b"));
    const session = makeStreamingSession({
      pendingMessages: [active, successor],
      currentTraceTurnId: "turn-provider-native",
      currentCrashRecoveryAttemptId: "attempt-provider-native",
      currentTurnPendingIds: [active.pendingId!],
      toolEffectFence: "provider_event_only",
    });
    const crashRecovery = {
      acceptingDeliveries: true,
      getActiveTurnAttempt: () => ({ startedTool: false, materializedOutput: false }),
    } as unknown as RuntimeCrashRecoveryCoordinator;
    const stash = new Map<string, RuntimeUserMessage[]>();

    expect(stashPendingRuntimeMessages("dev", session, stash, { crashRecovery })).toBe(1);
    expect(stash.get("dev")).toEqual([successor]);

    const reconciliationStash = new Map<string, RuntimeUserMessage[]>();
    expect(
      stashPendingRuntimeMessages("dev", session, reconciliationStash, {
        crashRecovery,
        reconcileCurrentTurn: true,
      }),
    ).toBe(2);
    expect(reconciliationStash.get("dev")?.[0]).toMatchObject({
      replay: true,
      terminalReplayAllowed: false,
    });
    expect(reconciliationStash.get("dev")?.[1]?.replay).toBeUndefined();
  });

  it("never replays a completed physical turn while preserving its independent successors", () => {
    const active = createQueuedRuntimeUserMessage(channelPrompt("already complete", "turn-a"));
    const successor = createQueuedRuntimeUserMessage(channelPrompt("independent successor", "turn-b"));
    const session = makeStreamingSession({
      pendingMessages: [active, successor],
      currentTurnPendingIds: [active.pendingId!],
      currentCrashRecoveryTerminal: {
        status: "complete",
        completedAt: Date.now(),
        startedTool: false,
        materializedOutput: false,
      },
      toolEffectFence: "host_write_ahead",
    });
    const beforeDrain = new Map<string, RuntimeUserMessage[]>();

    expect(stashPendingRuntimeMessages("dev", session, beforeDrain)).toBe(1);
    expect(beforeDrain.get("dev")).toEqual([successor]);

    session.pendingMessages = [successor];
    session.currentTurnPendingIds = undefined;
    const afterDrain = new Map<string, RuntimeUserMessage[]>();

    expect(stashPendingRuntimeMessages("dev", session, afterDrain)).toBe(1);
    expect(afterDrain.get("dev")).toEqual([successor]);
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

function channelPrompt(prompt: string, turnId: string, senderId = "user-a", threadId?: string) {
  return {
    prompt,
    deliveryBarrier: "after_tool" as const,
    source: {
      channel: "custom",
      accountId: "connection-a",
      instanceId: "channel-instance-a",
      chatId: "conversation-a",
      ...(threadId ? { threadId } : {}),
      canonicalChatId: "chat-a",
      actorType: "contact" as const,
      contactId: senderId,
      normalizedSenderId: senderId,
      sourceMessageId: `message-${turnId}`,
    },
    context: {
      channelId: "custom",
      channelName: "Custom",
      accountId: "connection-a",
      instanceId: "channel-instance-a",
      chatId: "conversation-a",
      canonicalChatId: "chat-a",
      messageId: `message-${turnId}`,
      senderId,
      isGroup: true,
      timestamp: 1,
      actorType: "contact" as const,
      contactId: senderId,
      normalizedSenderId: senderId,
    },
    _agentId: "agent-a",
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
