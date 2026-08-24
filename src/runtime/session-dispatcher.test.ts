import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { nats } from "../nats.js";
import type { RuntimeLaunchPrompt } from "./message-types.js";
import {
  RuntimeSessionDispatcher,
  buildStashedRestartPrompt,
  canUseNativeRuntimeSteer,
  fenceRuntimeNativeSteerInput,
  runtimeModelBrokerConfigurationRequiresRestart,
  runtimeModelBrokerRouteRequiresRestart,
  stashPromptForStartingSession,
} from "./session-dispatcher.js";
import { createQueuedRuntimeUserMessage } from "./delivery-queue.js";
import { RuntimeHostSubscriptions } from "./host-subscriptions.js";
import type { RuntimeUserMessage } from "./host-session.js";
import type { RuntimeHostStreamingSession } from "./host-session.js";
import type { RuntimeRecoveryExhaustedAlertInput } from "./runtime-recovery-alert.js";
import type { PendingRuntimeSessionStart } from "./session-launcher.js";
import { deleteSession, getOrCreateSession, getSessionByName, setSessionEphemeral } from "../router/sessions.js";
import {
  dbGetDaemonRestartPendingMessages,
  dbGetDaemonRestartSessionSnapshot,
  dbListEligibleDaemonRestartSessionSnapshots,
  dbMarkDaemonRestartResumeDelivered,
  dbRecordDaemonRestartSessionSnapshot,
  dbUpsertDaemonRestartEpoch,
} from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { querySessionTrace } from "../session-trace/query.js";
import { getSessionTurn } from "../session-trace/session-trace-db.js";
import { dbCompleteTask, dbCreateTask, dbDispatchTask } from "../tasks/task-db.js";
import { buildSessionRelayTurnOrigin } from "./turn-origin.js";
import type { RuntimeCrashRecoveryCoordinator } from "./crash-recovery.js";
import { buildDaemonRestartResumePrompt, resolveCrashRecoveryRestartResumeMode } from "./daemon-restart-resume.js";
import {
  buildRuntimeModelBrokerPhysicalFingerprint,
  buildRuntimeModelBrokerSelectionCompatibilityKey,
} from "./model-broker.js";

const crashRecoveryStub = { acceptingDeliveries: true } as unknown as RuntimeCrashRecoveryCoordinator;

describe("RuntimeSessionDispatcher model-broker preflight", () => {
  it("keeps a canonical supervised session when no explicit profile is persisted", () => {
    const canonicalSelection = { brokerId: "hub", profileRef: "canonical", required: true } as const;
    const existing = {
      currentRuntimeCredential: {
        authMethod: "model-broker",
        modelBrokerId: "hub",
        modelBrokerProfileRef: "canonical",
        modelBrokerSelectionCompatibilityKey: buildRuntimeModelBrokerSelectionCompatibilityKey(canonicalSelection),
      },
    } as unknown as Parameters<typeof runtimeModelBrokerConfigurationRequiresRestart>[0];

    expect(runtimeModelBrokerConfigurationRequiresRestart(existing, { defaults: null }, "false", "true")).toBe(false);
  });

  it("restarts a live Codex session when the authoritative lease selects Pi", () => {
    const existing = {
      currentModel: "gpt-5.5",
      queryHandle: { provider: "codex" },
      currentRuntimeCredential: {
        authMethod: "model-broker",
        modelBrokerId: "hub",
        modelBrokerProfileRef: "profile_main",
        modelBrokerRouteRevision: "route_codex",
        modelBrokerCompatibilityRevision: "compat_codex",
      },
    } as unknown as Parameters<typeof runtimeModelBrokerRouteRequiresRestart>[0];
    const plan = {
      brokerId: "hub",
      runtimeId: "runtime_a",
      agentId: "main",
      sessionKey: "agent:main:main",
      turnId: "turn_pi",
      selection: { brokerId: "hub", profileRef: "profile_main", required: true },
      lease: {
        version: 1,
        brokerId: "hub",
        leaseId: "lease_pi",
        attemptId: "attempt_pi",
        turnId: "turn_pi",
        runtimeId: "runtime_a",
        runtimeProvider: "pi",
        model: "openai/kimi-k2.5",
        routeRevision: "route_pi",
        compatibilityRevision: "compat_pi",
        expiresAt: Date.now() + 60_000,
        transport: {
          scheme: "local-http-forwarder-v1",
          protocol: "openai-completions",
          origin: "http://127.0.0.1:43123",
          path: "/v1/chat/completions",
          publicHeaders: {},
        },
      },
    } as const;

    expect(runtimeModelBrokerRouteRequiresRestart(existing, plan)).toBe(true);
  });

  it("keeps the physical session when only the per-turn public binding handle rotates", () => {
    const first = modelBrokerPlan("turn_first", "binding_first");
    const second = modelBrokerPlan("turn_second", "binding_second");
    const existing = {
      currentModel: first.lease.model,
      queryHandle: { provider: first.lease.runtimeProvider },
      currentRuntimeCredential: {
        authMethod: "model-broker",
        modelBrokerId: first.selection.brokerId,
        modelBrokerProfileRef: first.selection.profileRef,
        modelBrokerRouteRevision: first.lease.routeRevision,
        modelBrokerCompatibilityRevision: first.lease.compatibilityRevision,
        fingerprint: buildRuntimeModelBrokerPhysicalFingerprint(first.selection, first.lease),
      },
    } as unknown as Parameters<typeof runtimeModelBrokerRouteRequiresRestart>[0];

    expect(runtimeModelBrokerRouteRequiresRestart(existing, first)).toBe(false);
    expect(runtimeModelBrokerRouteRequiresRestart(existing, second)).toBe(false);
  });
});

function modelBrokerPlan(turnId: string, bindingHandle: string) {
  const selection = { brokerId: "hub", profileRef: "profile_main", required: true } as const;
  return {
    brokerId: "hub",
    runtimeId: "runtime_a",
    agentId: "main",
    sessionKey: "agent:main:main",
    turnId,
    selection,
    lease: {
      version: 1,
      brokerId: "hub",
      leaseId: `lease_${turnId}`,
      attemptId: `attempt_${turnId}`,
      turnId,
      runtimeId: "runtime_a",
      runtimeProvider: "codex",
      model: "gpt-5.5",
      routeRevision: "route_shared",
      compatibilityRevision: "compat_shared",
      expiresAt: Date.now() + 60_000,
      transport: {
        scheme: "local-http-forwarder-v1",
        protocol: "openai-responses",
        origin: "http://127.0.0.1:43123",
        path: "/v1/responses",
        publicHeaders: { "x-ravi-binding": bindingHandle },
      },
    },
  } as const;
}

function createDispatcher(
  maxConcurrentSessions = 10,
  interactiveReservedSessions = 0,
  crashRecovery: RuntimeCrashRecoveryCoordinator = crashRecoveryStub,
) {
  return new RuntimeSessionDispatcher({
    instanceId: "test",
    maxConcurrentSessions,
    interactiveReservedSessions,
    safeEmit: async () => {},
    notifyRuntimeRecoveryExhausted: async () => {},
    getConfigModel: () => "test-model",
    crashRecovery,
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

  it("does not merge prompts across typed authority origins", async () => {
    const dispatcher = createDispatcher();
    const prompts: RuntimeLaunchPrompt[] = [];
    (
      dispatcher as unknown as { handlePromptImmediate: typeof dispatcher.handlePromptImmediate }
    ).handlePromptImmediate = mock(async (_sessionName: string, prompt: RuntimeLaunchPrompt) => {
      prompts.push(prompt);
    });

    const source = { channel: "telegram", accountId: "main", chatId: "group:123" };
    dispatcher.handlePromptWithDebounce(
      "session",
      {
        prompt: "mensagem externa",
        source,
        _agentId: "agent-a",
        deliveryBarrier: "after_tool",
      },
      60_000,
    );
    dispatcher.handlePromptWithDebounce(
      "session",
      {
        prompt: "[System] Inform: mensagem interna",
        source,
        _agentId: "agent-a",
        deliveryBarrier: "after_tool",
        _turnOrigin: buildSessionRelayTurnOrigin("inform", {
          agentId: "origin-agent",
          sessionKey: "agent:origin-agent:main",
        }),
      },
      60_000,
    );

    await dispatcher.flushDebounce("session");

    expect(prompts).toHaveLength(2);
    expect(prompts[0]?.prompt).toBe("mensagem externa");
    expect(prompts[0]?._turnOrigin).toBeUndefined();
    expect(prompts[1]?.prompt).toBe("[System] Inform: mensagem interna");
    expect(prompts[1]?._turnOrigin).toMatchObject({
      producer: "session-relay",
      action: "inform",
      principal: { type: "agent", id: "origin-agent" },
    });
  });

  it("keeps each channel backend binding in its own debounced turn", async () => {
    const dispatcher = createDispatcher();
    const prompts: RuntimeLaunchPrompt[] = [];
    (
      dispatcher as unknown as { handlePromptImmediate: typeof dispatcher.handlePromptImmediate }
    ).handlePromptImmediate = mock(async (_sessionName: string, prompt: RuntimeLaunchPrompt) => {
      prompts.push(prompt);
    });

    const source = { channel: "custom", accountId: "connection-a", chatId: "conversation-a" };
    dispatcher.handlePromptWithDebounce(
      "session",
      {
        prompt: "primeiro turno",
        source,
        _agentId: "agent-a",
        _channelBackend: channelBackendMetadata("turn-1"),
      },
      60_000,
    );
    dispatcher.handlePromptWithDebounce(
      "session",
      {
        prompt: "segundo turno",
        source,
        _agentId: "agent-a",
        _channelBackend: channelBackendMetadata("turn-2"),
      },
      60_000,
    );

    await dispatcher.flushDebounce("session");

    expect(prompts.map((prompt) => prompt.prompt)).toEqual(["primeiro turno", "segundo turno"]);
    expect(prompts.map((prompt) => prompt._channelBackend?.binding.turnId)).toEqual(["turn-1", "turn-2"]);
  });

  it("keeps repeated typed origins in separate debounced turns", async () => {
    const dispatcher = createDispatcher();
    const prompts: RuntimeLaunchPrompt[] = [];
    (
      dispatcher as unknown as { handlePromptImmediate: typeof dispatcher.handlePromptImmediate }
    ).handlePromptImmediate = mock(async (_sessionName: string, prompt: RuntimeLaunchPrompt) => {
      prompts.push(prompt);
    });
    const originContext = {
      agentId: "origin-agent",
      sessionKey: "agent:origin-agent:main",
    };

    dispatcher.handlePromptWithDebounce(
      "session",
      {
        prompt: "primeiro inform",
        _turnOrigin: buildSessionRelayTurnOrigin("inform", originContext),
      },
      60_000,
    );
    dispatcher.handlePromptWithDebounce(
      "session",
      {
        prompt: "segundo inform",
        _turnOrigin: buildSessionRelayTurnOrigin("inform", originContext),
      },
      60_000,
    );

    await dispatcher.flushDebounce("session");

    expect(prompts.map((prompt) => prompt.prompt)).toEqual(["primeiro inform", "segundo inform"]);
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

function channelBackendMetadata(turnId: string): NonNullable<RuntimeLaunchPrompt["_channelBackend"]> {
  return {
    protocol: "ravi.channel.backend",
    schemaVersion: 1,
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
  };
}

describe("RuntimeSessionDispatcher runtime recovery", () => {
  afterEach(() => mock.restore());

  it("suppresses the channel response and alerts the operator after repeated event-loop closures", async () => {
    const emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];
    const channelResponses: Array<{ topic: string; data: Record<string, unknown> }> = [];
    const alerts: RuntimeRecoveryExhaustedAlertInput[] = [];
    spyOn(nats, "emit").mockImplementation(async (topic, data) => {
      if (topic.endsWith(".response")) channelResponses.push({ topic, data });
    });
    const dispatcher = new RuntimeSessionDispatcher({
      instanceId: "test",
      maxConcurrentSessions: 10,
      interactiveReservedSessions: 0,
      safeEmit: async (topic, data) => {
        emitted.push({ topic, data });
      },
      notifyRuntimeRecoveryExhausted: async (input) => {
        alerts.push(input);
      },
      getConfigModel: () => "test-model",
      crashRecovery: crashRecoveryStub,
    });
    dispatcher.stashedMessages.set("recovery-loop", [
      createQueuedRuntimeUserMessage({
        prompt: "retry me",
        source: {
          channel: "slack",
          accountId: "main",
          chatId: "C123",
          sourceMessageId: "message-123",
        },
        _agentId: "main",
      }),
    ]);

    let starts = 0;
    dispatcher.startStreamingSession = mock(async () => {
      starts++;
    });
    const recovery = dispatcher as unknown as {
      restartStashedSession(sessionName: string, reason: string): Promise<void>;
    };

    await recovery.restartStashedSession("recovery-loop", "runtime_event_loop_closed");
    await recovery.restartStashedSession("recovery-loop", "runtime_event_loop_closed");
    await recovery.restartStashedSession("recovery-loop", "runtime_event_loop_closed");

    expect(starts).toBe(2);
    expect(channelResponses).toEqual([]);
    expect(dispatcher.stashedMessages.has("recovery-loop")).toBe(true);
    expect(alerts).toEqual([
      expect.objectContaining({
        sessionName: "recovery-loop",
        reason: "runtime_event_loop_closed",
        restartAttempts: 2,
        stashedQueueSize: 1,
        sourceMessageId: "message-123",
      }),
    ]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      topic: "ravi.session.recovery-loop.runtime",
      data: {
        type: "dispatch.restart_suppressed",
        reason: "runtime_event_loop_closed",
        restartAttempts: 2,
        stashedQueueSize: 1,
        resumeStashedMessages: true,
        userResponseSuppressed: true,
      },
    });
  });

  it("allows one automatic restart for an inactive provider turn", async () => {
    const emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];
    const alerts: RuntimeRecoveryExhaustedAlertInput[] = [];
    const dispatcher = new RuntimeSessionDispatcher({
      instanceId: "test",
      maxConcurrentSessions: 10,
      interactiveReservedSessions: 0,
      safeEmit: async (topic, data) => {
        emitted.push({ topic, data });
      },
      notifyRuntimeRecoveryExhausted: async (input) => {
        alerts.push(input);
      },
      getConfigModel: () => "test-model",
      crashRecovery: crashRecoveryStub,
    });
    dispatcher.stashedMessages.set("inactive-turn", [
      createQueuedRuntimeUserMessage({ prompt: "retry once", _agentId: "main" }),
    ]);

    let starts = 0;
    dispatcher.startStreamingSession = mock(async () => {
      starts++;
    });
    const recovery = dispatcher as unknown as {
      restartStashedSession(sessionName: string, reason: string): Promise<void>;
    };

    await recovery.restartStashedSession("inactive-turn", "provider_turn_inactive");
    await recovery.restartStashedSession("inactive-turn", "provider_turn_inactive");

    expect(starts).toBe(1);
    expect(dispatcher.stashedMessages.has("inactive-turn")).toBe(true);
    expect(alerts).toEqual([
      expect.objectContaining({
        sessionName: "inactive-turn",
        reason: "provider_turn_inactive",
        restartAttempts: 1,
        stashedQueueSize: 1,
      }),
    ]);
    expect(emitted).toEqual([
      expect.objectContaining({
        topic: "ravi.session.inactive-turn.runtime",
        data: expect.objectContaining({
          type: "dispatch.restart_suppressed",
          reason: "provider_turn_inactive",
          restartAttempts: 1,
        }),
      }),
    ]);
  });

  it("bounds recoverable provider transport restarts", async () => {
    const emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];
    const alerts: RuntimeRecoveryExhaustedAlertInput[] = [];
    const dispatcher = new RuntimeSessionDispatcher({
      instanceId: "test",
      maxConcurrentSessions: 10,
      interactiveReservedSessions: 0,
      safeEmit: async (topic, data) => {
        emitted.push({ topic, data });
      },
      notifyRuntimeRecoveryExhausted: async (input) => {
        alerts.push(input);
      },
      getConfigModel: () => "test-model",
      crashRecovery: crashRecoveryStub,
    });
    dispatcher.stashedMessages.set("transport-failure", [
      createQueuedRuntimeUserMessage({ prompt: "retry transport", _agentId: "main" }),
    ]);

    let starts = 0;
    dispatcher.startStreamingSession = mock(async () => {
      starts++;
    });
    const recovery = dispatcher as unknown as {
      restartStashedSession(sessionName: string, reason: string): Promise<void>;
    };

    await recovery.restartStashedSession("transport-failure", "provider_transport_failure");
    await recovery.restartStashedSession("transport-failure", "provider_transport_failure");
    await recovery.restartStashedSession("transport-failure", "provider_transport_failure");

    expect(starts).toBe(2);
    expect(alerts).toEqual([
      expect.objectContaining({
        sessionName: "transport-failure",
        reason: "provider_transport_failure",
        restartAttempts: 2,
      }),
    ]);
    expect(emitted).toEqual([
      expect.objectContaining({
        topic: "ravi.session.transport-failure.runtime",
        data: expect.objectContaining({
          type: "dispatch.restart_suppressed",
          reason: "provider_transport_failure",
          restartAttempts: 2,
          userResponseSuppressed: true,
        }),
      }),
    ]);
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
      currentCrashRecoveryAttemptId: "attempt-native-steer",
      ...overrides,
    } as RuntimeHostStreamingSession;
  }

  it("allows active Pi steer when a durable attempt can fence the input mutation", () => {
    expect(canUseNativeRuntimeSteer(createStreamingSession(), "after_tool")).toBe(true);
    expect(canUseNativeRuntimeSteer(createStreamingSession(), "after_response")).toBe(false);
  });

  it("only native-steers input from the active turn's reply surface", () => {
    const activeSource = {
      channel: "slack",
      accountId: "slack-a",
      chatId: "C123",
      canonicalChatId: "chat-slack",
    };
    const session = createStreamingSession({ currentSource: activeSource });

    expect(
      canUseNativeRuntimeSteer(session, "after_tool", {
        prompt: "same chat",
        source: { ...activeSource },
      }),
    ).toBe(true);
    expect(
      canUseNativeRuntimeSteer(session, "after_tool", {
        prompt: "another chat",
        source: {
          channel: "whatsapp",
          accountId: "wa-a",
          chatId: "wa-test@s.whatsapp.net",
          canonicalChatId: "chat-whatsapp",
        },
      }),
    ).toBe(false);
  });

  it("never native-steers a durable channel turn envelope", () => {
    const source = {
      channel: "slack",
      accountId: "slack-a",
      chatId: "C123",
      canonicalChatId: "chat-slack",
    };
    expect(
      canUseNativeRuntimeSteer(createStreamingSession({ currentSource: source }), "after_tool", {
        prompt: "new durable turn",
        source,
        _channelBackend: channelBackendMetadata("turn-next"),
      }),
    ).toBe(false);
  });

  it("keeps active Pi input queued when no durable attempt owns the turn", () => {
    expect(
      canUseNativeRuntimeSteer(createStreamingSession({ currentCrashRecoveryAttemptId: undefined }), "after_tool"),
    ).toBe(false);
  });

  it("writes the input-mutation fence before enabling native steer", () => {
    const session = createStreamingSession();
    const calls: unknown[] = [];

    expect(
      fenceRuntimeNativeSteerInput(session, {
        markTurnAttemptSafety: (input) => {
          calls.push(input);
          return {} as never;
        },
      }),
    ).toBe(true);
    expect(calls).toEqual([{ attemptId: "attempt-native-steer", inputMutated: true }]);
    expect(session.currentTurnInputMutated).toBe(true);
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

  it("keeps Pi pre-turn input queued until a durable attempt can own it", () => {
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
    ).toBe(false);

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

  it("does not native steer past an already queued successor", () => {
    const active = createQueuedRuntimeUserMessage({ prompt: "active", deliveryBarrier: "after_tool" });
    const queued = createQueuedRuntimeUserMessage({ prompt: "queued", deliveryBarrier: "after_tool" });

    expect(
      canUseNativeRuntimeSteer(
        createStreamingSession({
          pendingMessages: [active, queued],
          currentTurnPendingIds: [active.pendingId!],
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
      toolEffectFence: "provider_event_only",
      ...overrides,
    };
  }

  it("defers abort until a completed dynamic tool result reaches the provider", async () => {
    const stateDir = await createIsolatedRaviState("ravi-runtime-dispatcher-tool-delivery-abort-");
    try {
      getOrCreateSession("agent:main:test:tool-delivery-abort", "main", stateDir, {
        name: "tool-delivery-abort",
      });
      const dispatcher = createDispatcher(2);
      const activeSession = createActiveSession({
        agentId: "main",
        turnActive: true,
        toolRunning: true,
        toolResultDeliveryPending: true,
        currentToolSafety: "safe",
        currentToolName: "tools_invoke",
      });
      dispatcher.streamingSessions.set("tool-delivery-abort", activeSession);

      expect(dispatcher.abortSession("tool-delivery-abort")).toBe(true);

      expect(activeSession.pendingAbort).toBe(true);
      expect(activeSession.internalAbortReason).toBe("explicit_abort_deferred");
      expect(activeSession.abortController.signal.aborted).toBe(false);
      expect(dispatcher.streamingSessions.get("tool-delivery-abort")).toBe(activeSession);
    } finally {
      await cleanupIsolatedRaviState(stateDir);
    }
  });

  it("continues closing every provider when one shutdown terminal fence fails", async () => {
    const stateDir = await createIsolatedRaviState("ravi-runtime-dispatcher-shutdown-cleanup-");
    try {
      getOrCreateSession("agent:dev:test:shutdown-first", "dev", stateDir, { name: "shutdown-first" });
      getOrCreateSession("agent:dev:test:shutdown-second", "dev", stateDir, { name: "shutdown-second" });
      const interrupted: string[] = [];
      const terminalizeTurnAttempt = mock((input: { attemptId: string; status: "aborted"; completedAt: number }) => {
        if (input.attemptId === "attempt-first") {
          throw new Error("lost first terminal fence");
        }
        return {
          ...input,
          startedTool: false,
          materializedOutput: false,
        };
      });
      const crashRecovery = {
        acceptingDeliveries: true,
        ownershipFailure: null,
        getActiveTurnAttempt: (attemptId: string) => ({
          attemptId,
          startedTool: false,
          materializedOutput: false,
        }),
        terminalizeTurnAttempt,
      } as unknown as RuntimeCrashRecoveryCoordinator;
      const dispatcher = createDispatcher(2, 0, crashRecovery);
      const first = createActiveSession({
        currentCrashRecoveryAttemptId: "attempt-first",
        queryHandle: {
          provider: "codex",
          events: (async function* () {})(),
          interrupt: async () => {
            interrupted.push("first");
          },
        },
      });
      const second = createActiveSession({
        currentCrashRecoveryAttemptId: "attempt-second",
        queryHandle: {
          provider: "codex",
          events: (async function* () {})(),
          interrupt: async () => {
            interrupted.push("second");
          },
        },
      });
      dispatcher.streamingSessions.set("shutdown-first", first);
      dispatcher.streamingSessions.set("shutdown-second", second);

      expect(() => dispatcher.shutdownAll()).toThrow("lost first terminal fence");

      await Promise.resolve();
      expect(first.done).toBe(true);
      expect(second.done).toBe(true);
      expect(interrupted.sort()).toEqual(["first", "second"]);
      expect(dispatcher.streamingSessions.size).toBe(0);
      expect(terminalizeTurnAttempt).toHaveBeenCalledTimes(2);
    } finally {
      await cleanupIsolatedRaviState(stateDir);
    }
  });

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
      const supersededMessage = createQueuedRuntimeUserMessage({
        prompt: "superseded user work",
        deliveryBarrier: "after_tool",
      });
      const queuedMessage = createQueuedRuntimeUserMessage({
        prompt: "queued user work",
        deliveryBarrier: "after_response",
      });
      dispatcher.streamingSessions.set(
        "restart-active",
        createActiveSession({
          turnActive: true,
          lastActivity: now - 1_000,
          currentSource: {
            channel: "whatsapp",
            accountId: "main",
            chatId: "120363424772797713@g.us",
            canonicalChatId: "chat_dev",
            sourceMessageId: "wamid-active",
            actorType: "contact",
            contactId: "contact_luis",
            rawSenderId: "178035101794451",
            normalizedSenderId: "5511947879044",
          },
          pendingMessages: [supersededMessage, queuedMessage],
          currentTurnPendingIds: [supersededMessage.pendingId!],
          currentTurnSuperseded: true,
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
      expect(eligible[0]?.metadata?.currentSource).toMatchObject({
        channel: "whatsapp",
        accountId: "main",
        chatId: "120363424772797713@g.us",
        canonicalChatId: "chat_dev",
        sourceMessageId: "wamid-active",
        actorType: "contact",
        contactId: "contact_luis",
      });

      const pending = dbGetDaemonRestartPendingMessages("epoch-active", "agent:dev:test:restart-active");
      expect((pending[0] as RuntimeUserMessage | undefined)?.message.content).toBe("queued user work");
    } finally {
      await cleanupIsolatedRaviState(stateDir);
    }
  });

  it("excludes an unsafe physical turn from daemon restart snapshots while preserving successors", async () => {
    const stateDir = await createIsolatedRaviState("ravi-runtime-dispatcher-safe-restart-snapshot-");
    try {
      const now = Date.now();
      const sessionKey = "agent:dev:test:restart-unsafe";
      const sessionName = "restart-unsafe";
      getOrCreateSession(sessionKey, "dev", stateDir, { name: sessionName });
      dbUpsertDaemonRestartEpoch({ restartEpoch: "epoch-unsafe", reason: "test", createdAt: now });
      const crashRecovery = {
        acceptingDeliveries: true,
        getActiveTurnAttempt: (attemptId: string) => ({
          attemptId,
          startedTool: false,
          materializedOutput: true,
        }),
      } as unknown as RuntimeCrashRecoveryCoordinator;
      const dispatcher = createDispatcher(1, 0, crashRecovery);
      const active = createQueuedRuntimeUserMessage({ prompt: "already materialized" });
      const successor = createQueuedRuntimeUserMessage({ prompt: "independent successor" });
      dispatcher.streamingSessions.set(
        sessionName,
        createActiveSession({
          turnActive: true,
          currentTraceTurnId: "turn-unsafe-snapshot",
          currentCrashRecoveryAttemptId: "attempt-unsafe-snapshot",
          currentTurnPendingIds: active.pendingId ? [active.pendingId] : [],
          pendingMessages: [active, successor],
        }),
      );

      expect(
        dispatcher.recordDaemonRestartSnapshot({
          restartEpoch: "epoch-unsafe",
          reason: "test",
          stoppedAt: now,
        }),
      ).toBe(1);

      const pending = dbGetDaemonRestartPendingMessages("epoch-unsafe", sessionKey) as RuntimeUserMessage[];
      expect(pending.map((message) => message.message.content)).toEqual(["independent successor"]);
      const snapshot = dbListEligibleDaemonRestartSessionSnapshots({
        restartEpoch: "epoch-unsafe",
        now: now + 1,
      })[0];
      const mode = resolveCrashRecoveryRestartResumeMode(snapshot?.metadata);
      expect(mode).toBe("pending_only");
      const payload = buildDaemonRestartResumePrompt({
        restartEpoch: "epoch-unsafe",
        reason: "test",
        sessionKey,
        mode,
      });
      expect(payload?._daemonRestartResume?.pendingOnly).toBe(true);
      const prepared = (
        dispatcher as unknown as {
          prepareDaemonRestartResumePrompt(
            requestedSessionName: string,
            prompt: RuntimeLaunchPrompt,
            sessionEntry: null,
          ): { prompt: RuntimeLaunchPrompt; messages: RuntimeUserMessage[] } | null;
        }
      ).prepareDaemonRestartResumePrompt(sessionName, payload!, null);
      expect(prepared?.prompt.prompt).toBe("independent successor");
      expect(prepared?.prompt.prompt).not.toContain("Continue de onde parou");
      expect(prepared?.messages.map((message) => message.pendingId)).toEqual([successor.pendingId]);
    } finally {
      await cleanupIsolatedRaviState(stateDir);
    }
  });

  it("treats an unfenced provider-native turn as unsafe before any asynchronous tool marker", async () => {
    const stateDir = await createIsolatedRaviState("ravi-runtime-dispatcher-provider-native-snapshot-");
    try {
      const now = Date.now();
      const sessionKey = "agent:dev:test:restart-provider-native";
      const sessionName = "restart-provider-native";
      getOrCreateSession(sessionKey, "dev", stateDir, { name: sessionName });
      dbUpsertDaemonRestartEpoch({ restartEpoch: "epoch-provider-native", reason: "test", createdAt: now });
      const crashRecovery = {
        acceptingDeliveries: true,
        getActiveTurnAttempt: (attemptId: string) => ({
          attemptId,
          startedTool: false,
          materializedOutput: false,
        }),
      } as unknown as RuntimeCrashRecoveryCoordinator;
      const dispatcher = createDispatcher(1, 0, crashRecovery);
      const active = createQueuedRuntimeUserMessage({ prompt: "provider-native effect may have started" });
      const successor = createQueuedRuntimeUserMessage({ prompt: "safe independent successor" });
      dispatcher.streamingSessions.set(
        sessionName,
        createActiveSession({
          turnActive: true,
          currentTraceTurnId: "turn-provider-native-snapshot",
          currentCrashRecoveryAttemptId: "attempt-provider-native-snapshot",
          currentTurnPendingIds: active.pendingId ? [active.pendingId] : [],
          pendingMessages: [active, successor],
          toolEffectFence: "provider_event_only",
        }),
      );

      expect(
        dispatcher.recordDaemonRestartSnapshot({
          restartEpoch: "epoch-provider-native",
          reason: "test",
          stoppedAt: now,
        }),
      ).toBe(1);

      const pending = dbGetDaemonRestartPendingMessages("epoch-provider-native", sessionKey) as RuntimeUserMessage[];
      expect(pending.map((message) => message.message.content)).toEqual(["safe independent successor"]);
      const snapshot = dbListEligibleDaemonRestartSessionSnapshots({
        restartEpoch: "epoch-provider-native",
        now: now + 1,
      })[0];
      expect(resolveCrashRecoveryRestartResumeMode(snapshot?.metadata)).toBe("pending_only");
    } finally {
      await cleanupIsolatedRaviState(stateDir);
    }
  });

  it("suppresses daemon restart continuation for an unsafe turn without successors", async () => {
    const stateDir = await createIsolatedRaviState("ravi-runtime-dispatcher-skip-restart-snapshot-");
    try {
      const now = Date.now();
      const sessionKey = "agent:dev:test:restart-unsafe-only";
      const sessionName = "restart-unsafe-only";
      getOrCreateSession(sessionKey, "dev", stateDir, { name: sessionName });
      dbUpsertDaemonRestartEpoch({ restartEpoch: "epoch-unsafe-only", reason: "test", createdAt: now });
      const crashRecovery = {
        acceptingDeliveries: true,
        getActiveTurnAttempt: (attemptId: string) => ({
          attemptId,
          startedTool: true,
          materializedOutput: false,
        }),
      } as unknown as RuntimeCrashRecoveryCoordinator;
      const dispatcher = createDispatcher(1, 0, crashRecovery);
      const active = createQueuedRuntimeUserMessage({ prompt: "unsafe only" });
      dispatcher.streamingSessions.set(
        sessionName,
        createActiveSession({
          turnActive: true,
          currentTraceTurnId: "turn-unsafe-only",
          currentCrashRecoveryAttemptId: "attempt-unsafe-only",
          currentTurnPendingIds: active.pendingId ? [active.pendingId] : [],
          pendingMessages: [active],
        }),
      );

      expect(
        dispatcher.recordDaemonRestartSnapshot({
          restartEpoch: "epoch-unsafe-only",
          reason: "test",
          stoppedAt: now,
        }),
      ).toBe(1);

      const snapshot = dbListEligibleDaemonRestartSessionSnapshots({
        restartEpoch: "epoch-unsafe-only",
        now: now + 1,
      })[0];
      expect(snapshot?.pendingMessageCount).toBe(0);
      const mode = resolveCrashRecoveryRestartResumeMode(snapshot?.metadata);
      expect(mode).toBe("skip");
      expect(
        buildDaemonRestartResumePrompt({
          restartEpoch: "epoch-unsafe-only",
          reason: "test",
          sessionKey,
          mode,
        }),
      ).toBeNull();
    } finally {
      await cleanupIsolatedRaviState(stateDir);
    }
  });

  it("treats a provider-terminal turn as consumed in daemon restart snapshots", async () => {
    const stateDir = await createIsolatedRaviState("ravi-runtime-dispatcher-terminal-restart-snapshot-");
    try {
      const now = Date.now();
      const sessionKey = "agent:dev:test:restart-terminal";
      const sessionName = "restart-terminal";
      getOrCreateSession(sessionKey, "dev", stateDir, { name: sessionName });
      dbUpsertDaemonRestartEpoch({ restartEpoch: "epoch-terminal", reason: "test", createdAt: now });
      const dispatcher = createDispatcher();
      const consumed = createQueuedRuntimeUserMessage({ prompt: "already completed" });
      dispatcher.streamingSessions.set(
        sessionName,
        createActiveSession({
          turnActive: false,
          currentTraceTurnId: "turn-terminal-snapshot",
          currentTraceTurnTerminalRecorded: true,
          currentCrashRecoveryTerminal: {
            status: "complete",
            completedAt: now - 1,
            startedTool: false,
            materializedOutput: false,
          },
          currentTurnPendingIds: consumed.pendingId ? [consumed.pendingId] : [],
          pendingMessages: [consumed],
        }),
      );

      expect(
        dispatcher.recordDaemonRestartSnapshot({
          restartEpoch: "epoch-terminal",
          reason: "test",
          stoppedAt: now,
        }),
      ).toBe(1);

      expect(dbGetDaemonRestartPendingMessages("epoch-terminal", sessionKey)).toHaveLength(0);
      const snapshot = dbListEligibleDaemonRestartSessionSnapshots({
        restartEpoch: "epoch-terminal",
        now: now + 1,
      })[0];
      expect(resolveCrashRecoveryRestartResumeMode(snapshot?.metadata)).toBe("skip");
      expect(snapshot?.metadata?.crashRecoveryTerminalStatus).toBe("complete");
    } finally {
      await cleanupIsolatedRaviState(stateDir);
    }
  });

  it("preserves post-drain successors while a completed terminal latch is still retained", async () => {
    const stateDir = await createIsolatedRaviState("ravi-runtime-dispatcher-terminal-post-drain-snapshot-");
    try {
      const now = Date.now();
      const sessionKey = "agent:dev:test:restart-terminal-post-drain";
      const sessionName = "restart-terminal-post-drain";
      getOrCreateSession(sessionKey, "dev", stateDir, { name: sessionName });
      dbUpsertDaemonRestartEpoch({ restartEpoch: "epoch-terminal-post-drain", reason: "test", createdAt: now });
      const dispatcher = createDispatcher();
      const successor = createQueuedRuntimeUserMessage({ prompt: "successor after completed drain" });
      dispatcher.streamingSessions.set(
        sessionName,
        createActiveSession({
          turnActive: false,
          currentTraceTurnId: "turn-terminal-post-drain",
          currentTraceTurnTerminalRecorded: true,
          currentCrashRecoveryTerminal: {
            status: "complete",
            completedAt: now - 1,
            startedTool: false,
            materializedOutput: false,
          },
          currentTurnPendingIds: undefined,
          pendingMessages: [successor],
        }),
      );

      expect(
        dispatcher.recordDaemonRestartSnapshot({
          restartEpoch: "epoch-terminal-post-drain",
          reason: "test",
          stoppedAt: now,
        }),
      ).toBe(1);

      const pending = dbGetDaemonRestartPendingMessages(
        "epoch-terminal-post-drain",
        sessionKey,
      ) as RuntimeUserMessage[];
      expect(pending.map((message) => message.message.content)).toEqual(["successor after completed drain"]);
      expect(pending.map((message) => message.pendingId)).toEqual([successor.pendingId]);
      const snapshot = dbListEligibleDaemonRestartSessionSnapshots({
        restartEpoch: "epoch-terminal-post-drain",
        now: now + 1,
      })[0];
      expect(resolveCrashRecoveryRestartResumeMode(snapshot?.metadata)).toBe("pending_only");
    } finally {
      await cleanupIsolatedRaviState(stateDir);
    }
  });

  it("hydrates pending-only restart successors into an existing runtime without a duplicate stash", async () => {
    const stateDir = await createIsolatedRaviState("ravi-runtime-dispatcher-existing-pending-only-");
    try {
      const now = Date.now();
      const sessionKey = "agent:main:test:restart-existing";
      const sessionName = "restart-existing";
      getOrCreateSession(sessionKey, "main", stateDir, { name: sessionName });
      dbUpsertDaemonRestartEpoch({ restartEpoch: "epoch-existing", reason: "test", createdAt: now });
      const firstSuccessor = createQueuedRuntimeUserMessage({
        prompt: "first durable successor for existing runtime",
        deliveryBarrier: "after_response",
        source: {
          channel: "whatsapp",
          accountId: "main",
          chatId: "group:first",
          actorType: "contact",
          contactId: "contact-first",
        },
      });
      const secondSuccessor = createQueuedRuntimeUserMessage({
        prompt: "second durable successor for existing runtime",
        deliveryBarrier: "after_task",
        taskBarrierTaskId: "task-successor",
        source: {
          channel: "slack",
          accountId: "ravi-slack",
          chatId: "channel:second",
          actorType: "contact",
          contactId: "contact-second",
        },
      });
      dbRecordDaemonRestartSessionSnapshot({
        restartEpoch: "epoch-existing",
        sessionKey,
        sessionName,
        activity: "queued",
        nonIdle: true,
        lastActivityAt: now,
        stoppedAt: now,
        pendingMessages: [firstSuccessor, secondSuccessor],
        metadata: { crashRecoveryRestartResumeMode: "pending_only" },
      });
      const dispatcher = createDispatcher();
      let woke = false;
      const existing = createActiveSession({
        agentId: "main",
        turnActive: false,
        currentEffort: "xhigh",
        currentTaskBarrierTaskId: "task-successor",
        pushMessage: () => {
          woke = true;
        },
      });
      dispatcher.streamingSessions.set(sessionName, existing);
      const payload = buildDaemonRestartResumePrompt({
        restartEpoch: "epoch-existing",
        reason: "test",
        sessionKey,
        mode: "pending_only",
      });
      if (!payload) throw new Error("pending-only payload unexpectedly missing");

      await dispatcher.handlePromptImmediate(sessionName, payload);

      expect(existing.pendingMessages.map((message) => message.message.content)).toEqual([
        "first durable successor for existing runtime",
        "second durable successor for existing runtime",
      ]);
      expect(existing.pendingMessages.map((message) => message.pendingId)).toEqual([
        firstSuccessor.pendingId,
        secondSuccessor.pendingId,
      ]);
      expect(existing.pendingMessages.map((message) => message.deliveryBarrier)).toEqual([
        "after_response",
        "after_task",
      ]);
      expect(existing.pendingMessages.map((message) => message.launchPrompt?.source?.contactId)).toEqual([
        "contact-first",
        "contact-second",
      ]);
      expect(existing.pendingMessages[1]?.taskBarrierTaskId).toBe("task-successor");
      expect(dispatcher.stashedMessages.has(sessionName)).toBe(false);
      expect(existing.pendingMessages.some((message) => message.launchPrompt?._daemonRestartResume)).toBe(false);
      expect(woke).toBe(true);
    } finally {
      await cleanupIsolatedRaviState(stateDir);
    }
  });

  it("hydrates pending-only restart successors once while a cold start is already in flight", async () => {
    const stateDir = await createIsolatedRaviState("ravi-runtime-dispatcher-starting-pending-only-");
    try {
      const now = Date.now();
      const sessionKey = "agent:main:test:restart-starting";
      const sessionName = "restart-starting";
      getOrCreateSession(sessionKey, "main", stateDir, { name: sessionName });
      dbUpsertDaemonRestartEpoch({ restartEpoch: "epoch-starting", reason: "test", createdAt: now });
      const successor = createQueuedRuntimeUserMessage({
        prompt: "durable successor for starting runtime",
        deliveryBarrier: "after_response",
      });
      dbRecordDaemonRestartSessionSnapshot({
        restartEpoch: "epoch-starting",
        sessionKey,
        sessionName,
        activity: "starting",
        nonIdle: true,
        lastActivityAt: now,
        stoppedAt: now,
        pendingMessages: [successor],
        metadata: { crashRecoveryRestartResumeMode: "pending_only" },
      });
      const dispatcher = createDispatcher();
      dispatcher.startingSessions.add(sessionName);
      const payload = buildDaemonRestartResumePrompt({
        restartEpoch: "epoch-starting",
        reason: "test",
        sessionKey,
        mode: "pending_only",
      });
      if (!payload) throw new Error("pending-only payload unexpectedly missing");

      await dispatcher.handlePromptImmediate(sessionName, payload);

      const stashed = dispatcher.stashedMessages.get(sessionName);
      expect(stashed).toHaveLength(1);
      expect(stashed?.[0]?.message.content).toBe("durable successor for starting runtime");
      expect(stashed?.[0]?.pendingId).toBe(successor.pendingId);
      expect(stashed?.[0]?.launchPrompt?._daemonRestartResume).toBeUndefined();
      expect(stashed?.[0]?.message.content).not.toContain("Continue de onde parou");
    } finally {
      await cleanupIsolatedRaviState(stateDir);
    }
  });

  it("preserves actor metadata when a daemon restart resume envelope is appended to persisted work", () => {
    const original = createQueuedRuntimeUserMessage({
      prompt: "continue the user work",
      source: {
        channel: "whatsapp",
        accountId: "main",
        chatId: "120363424772797713@g.us",
        canonicalChatId: "chat_dev",
        sourceMessageId: "wamid-original",
        actorType: "contact",
        contactId: "contact_luis",
      },
      context: {
        channelId: "whatsapp",
        channelName: "WhatsApp",
        accountId: "main",
        chatId: "120363424772797713@g.us",
        canonicalChatId: "chat_dev",
        messageId: "wamid-original",
        senderId: "178035101794451",
        senderName: "Luís Filipe",
        isGroup: true,
        groupName: "ravi - dev",
        timestamp: Date.now(),
        actorType: "contact",
        contactId: "contact_luis",
      },
    });
    const resume = createQueuedRuntimeUserMessage({
      prompt: "[System] Daemon reiniciou (test). Continue de onde parou.",
      deliveryBarrier: "after_response",
      deliveryBarrierSource: "default",
      _daemonRestartResume: {
        restartEpoch: "restart-test",
        sessionKey: "agent:dev:whatsapp:main:group:120363424772797713",
      },
    });

    const restartPrompt = buildStashedRestartPrompt([original, resume]);

    expect(restartPrompt?.source).toMatchObject({
      channel: "whatsapp",
      accountId: "main",
      chatId: "120363424772797713@g.us",
      canonicalChatId: "chat_dev",
      actorType: "contact",
      contactId: "contact_luis",
    });
    expect(restartPrompt?.context).toMatchObject({
      actorType: "contact",
      contactId: "contact_luis",
      senderName: "Luís Filipe",
    });
    expect(restartPrompt?._resumeStashedMessages).toBe(true);
    expect(restartPrompt?.prompt).toContain("continue the user work");
    expect(restartPrompt?.prompt).toContain("Daemon reiniciou");
  });

  it("selects the stashed agent envelope when daemon restart metadata is appended", () => {
    const original = createQueuedRuntimeUserMessage({
      prompt: "continue agent handoff",
      source: {
        channel: "slack",
        accountId: "ravi-slack",
        chatId: "C123",
        canonicalChatId: "chat_slack",
        sourceMessageId: "1713000130.000200",
        actorType: "agent",
        actorAgentId: "foreign-agent",
      },
      context: {
        channelId: "slack",
        channelName: "Slack",
        accountId: "ravi-slack",
        chatId: "C123",
        canonicalChatId: "chat_slack",
        messageId: "1713000130.000200",
        senderId: "UFOREIGN",
        isGroup: true,
        timestamp: Date.now(),
        actorType: "agent",
        actorAgentId: "foreign-agent",
      },
    });
    const resume = createQueuedRuntimeUserMessage({
      prompt: "[System] Daemon reiniciou (test). Continue de onde parou.",
      deliveryBarrier: "after_response",
      deliveryBarrierSource: "default",
      _daemonRestartResume: {
        restartEpoch: "restart-agent-test",
        sessionKey: "agent:dev:slack:ravi-slack:group:C123",
      },
    });

    const restartPrompt = buildStashedRestartPrompt([original, resume]);

    expect(restartPrompt?.source).toMatchObject({
      channel: "slack",
      canonicalChatId: "chat_slack",
      actorType: "agent",
      actorAgentId: "foreign-agent",
    });
    expect(restartPrompt?.context).toMatchObject({
      actorType: "agent",
      actorAgentId: "foreign-agent",
      senderId: "UFOREIGN",
    });
    expect(restartPrompt?._resumeStashedMessages).toBe(true);
  });

  it("does not replace the active turn source when an after_response session followup is queued", async () => {
    const stateDir = await createIsolatedRaviState("ravi-runtime-dispatcher-followup-source-");
    try {
      getOrCreateSession("agent:main:test:followup-source", "main", stateDir, { name: "followup-source" });
      const activeSource: NonNullable<RuntimeHostStreamingSession["currentSource"]> = {
        channel: "whatsapp",
        accountId: "main",
        chatId: "120363424239734858@g.us",
        canonicalChatId: "chat_audit",
        sourceMessageId: "wamid-active",
        actorType: "contact",
        contactId: "contact_luis",
        rawSenderId: "178035101794451",
        normalizedSenderId: "5511947879044",
      };
      const followupSource: NonNullable<RuntimeHostStreamingSession["currentSource"]> = {
        channel: "whatsapp",
        accountId: "main",
        chatId: "120363424239734858@g.us",
        canonicalChatId: "chat_audit",
        actorType: "automation",
        automationId: "session-followup:sfup_source_probe",
        identityProvenance: { source: "session-followup" },
      };
      const dispatcher = createDispatcher(2);
      const activeSession = createActiveSession({
        agentId: "main",
        turnActive: true,
        currentEffort: "xhigh",
        currentSource: activeSource,
      });
      dispatcher.streamingSessions.set("followup-source", activeSession);

      await dispatcher.handlePromptImmediate("followup-source", {
        prompt: "[Session Followup: source probe] Respond exactly @@SILENT@@.",
        _agentId: "main",
        deliveryBarrier: "after_response",
        deliveryBarrierSource: "default",
        _sessionFollowup: true,
        _sessionFollowupCadenceId: "sfup_source_probe",
        _sessionFollowupRunId: "sfr_source_probe",
        source: followupSource,
        context: {
          channelId: "whatsapp",
          channelName: "WhatsApp",
          accountId: "main",
          chatId: "120363424239734858@g.us",
          canonicalChatId: "chat_audit",
          messageId: "session-followup:sfup_source_probe",
          senderId: "session-followup:sfup_source_probe",
          senderName: "Session Followup",
          isGroup: true,
          groupName: "Ravi - Audit",
          timestamp: Date.now(),
          actorType: "automation",
          automationId: "session-followup:sfup_source_probe",
          identityProvenance: { source: "session-followup" },
        },
      });

      expect(activeSession.currentSource).toEqual(activeSource);
      expect(activeSession.pendingMessages).toHaveLength(1);
      expect(activeSession.pendingMessages[0]?.deliveryBarrier).toBe("after_response");
      expect(activeSession.pendingMessages[0]?.launchPrompt?.source).toEqual(followupSource);
      expect(activeSession.pendingMessages[0]?.launchPrompt?._sessionFollowup).toBe(true);
    } finally {
      await cleanupIsolatedRaviState(stateDir);
    }
  });

  it("queues another surface without replacing or interrupting the active turn", async () => {
    const stateDir = await createIsolatedRaviState("ravi-runtime-dispatcher-interrupt-source-");
    try {
      getOrCreateSession("agent:main:test:interrupt-source", "main", stateDir, { name: "interrupt-source" });
      const activeSource: NonNullable<RuntimeHostStreamingSession["currentSource"]> = {
        channel: "whatsapp",
        accountId: "main",
        chatId: "wa-active",
        canonicalChatId: "chat_dm",
        sourceMessageId: "wamid-active",
      };
      const slackSource: NonNullable<RuntimeHostStreamingSession["currentSource"]> = {
        channel: "slack",
        accountId: "slack-main",
        chatId: "C123",
        canonicalChatId: "chat_slack",
        sourceMessageId: "123.456",
      };
      const interrupt = mock(async () => {});
      const activeMessage = createQueuedRuntimeUserMessage({
        prompt: "active work",
        deliveryBarrier: "after_tool",
        source: activeSource,
      });
      const dispatcher = createDispatcher(2);
      const activeSession = createActiveSession({
        agentId: "main",
        turnActive: true,
        currentEffort: "xhigh",
        currentSource: activeSource,
        pendingMessages: [activeMessage],
        currentTurnPendingIds: [activeMessage.pendingId!],
        queryHandle: {
          provider: "codex",
          events: (async function* () {})(),
          interrupt,
        },
      });
      dispatcher.streamingSessions.set("interrupt-source", activeSession);

      await dispatcher.handlePromptImmediate("interrupt-source", {
        prompt: "[Slack C123 mid:123.456] <@U123>: hello",
        _agentId: "main",
        deliveryBarrier: "after_tool",
        deliveryBarrierSource: "default",
        source: slackSource,
        context: {
          channelId: "slack",
          channelName: "Slack",
          accountId: "slack-main",
          chatId: "C123",
          canonicalChatId: "chat_slack",
          messageId: "123.456",
          senderId: "U123",
          senderName: "<@U123>",
          isGroup: true,
          groupName: "C123",
          timestamp: Date.now(),
        },
      });

      expect(activeSession.currentSource).toEqual(activeSource);
      expect(activeSession.pendingMessages).toHaveLength(2);
      expect(activeSession.pendingMessages[1]?.deliveryBarrier).toBe("after_tool");
      expect(activeSession.pendingMessages[1]?.launchPrompt?.source).toEqual(slackSource);
      expect(activeSession.pendingMessages[1]?.message.content).toBe(
        "[session surface] This turn came from a Slack chat. A normal reply returns there.\n" +
          "[Slack C123 mid:123.456] <@U123>: hello",
      );
      expect(activeSession.pendingMessages[1]?.launchPrompt?._sessionSurfaceHint).toBe(true);
      expect(activeSession.currentTurnSuperseded).not.toBe(true);
      expect(activeSession.interrupted).not.toBe(true);
      expect(interrupt).not.toHaveBeenCalled();
    } finally {
      await cleanupIsolatedRaviState(stateDir);
    }
  });

  it("interrupts for a queued after_tool prompt as soon as the tool barrier releases", async () => {
    const stateDir = await createIsolatedRaviState("ravi-runtime-dispatcher-tool-release-");
    try {
      getOrCreateSession("agent:main:test:tool-release", "main", stateDir, { name: "tool-release" });
      const interrupt = mock(async () => {});
      const activeMessage = createQueuedRuntimeUserMessage({
        prompt: "active tool work",
        deliveryBarrier: "after_tool",
      });
      const successor = createQueuedRuntimeUserMessage({
        prompt: "new direction after tool",
        deliveryBarrier: "after_tool",
      });
      const dispatcher = createDispatcher(2);
      const activeSession = createActiveSession({
        agentId: "main",
        turnActive: true,
        toolRunning: false,
        pendingMessages: [activeMessage, successor],
        currentTurnPendingIds: [activeMessage.pendingId!],
        queryHandle: {
          provider: "codex",
          events: (async function* () {})(),
          interrupt,
        },
      });
      dispatcher.streamingSessions.set("tool-release", activeSession);

      await (
        dispatcher as unknown as {
          releaseQueuedPromptsAfterTool(sessionName: string): Promise<void>;
        }
      ).releaseQueuedPromptsAfterTool("tool-release");

      expect(activeSession.currentTurnSuperseded).toBe(true);
      expect(activeSession.interrupted).toBe(true);
      expect(activeSession.pendingMessages.map((message) => message.message.content)).toEqual([
        "active tool work",
        "new direction after tool",
      ]);
      expect(interrupt).toHaveBeenCalledTimes(1);
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
      expect(dbGetDaemonRestartSessionSnapshot("epoch-window", "agent:dev:test:restart-stale")).toMatchObject({
        sessionName: "restart-stale",
        nonIdle: true,
      });

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

  it("terminalizes an active attempt even when the trace terminal guard is already set", () => {
    const order: string[] = [];
    const terminalizeTurnAttempt = mock((input: { status: "aborted"; completedAt: number }) => {
      order.push("attempt-terminal");
      return { status: input.status, completedAt: input.completedAt };
    });
    const crashRecovery = {
      acceptingDeliveries: true,
      terminalizeTurnAttempt,
    } as unknown as RuntimeCrashRecoveryCoordinator;
    const dispatcher = createDispatcher(1, 0, crashRecovery);
    const session = createActiveSession({
      turnActive: true,
      currentTraceTurnId: "turn-already-terminal",
      currentTraceTurnTerminalRecorded: true,
      currentCrashRecoveryAttemptId: "attempt-still-running",
      queryHandle: {
        provider: "codex",
        events: (async function* () {})(),
        interrupt: async () => {
          order.push("provider-interrupt");
        },
      },
    });
    dispatcher.streamingSessions.set("attempt-guard", session);

    expect(dispatcher.abortSession("attempt-guard", { reason: "test_abort" })).toBe(true);
    expect(terminalizeTurnAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptId: "attempt-still-running",
        status: "aborted",
      }),
    );
    expect(session.currentCrashRecoveryAttemptId).toBeUndefined();
    expect(session.currentCrashRecoveryTerminal).toMatchObject({
      status: "aborted",
      completedAt: expect.any(Number),
    });
    expect(order[0]).toBe("attempt-terminal");
  });

  it("does not fabricate a terminal latch or trace after crash recovery ownership is lost", async () => {
    const stateDir = await createIsolatedRaviState("ravi-runtime-dispatcher-ownership-loss-");
    try {
      const sessionKey = "agent:dev:test:ownership-loss";
      const sessionName = "ownership-loss";
      getOrCreateSession(sessionKey, "dev", stateDir, { name: sessionName });
      const terminalizeTurnAttempt = mock(() => {
        throw new Error("terminalization must not run without an owned attempt binding");
      });
      const crashRecovery = {
        acceptingDeliveries: false,
        ownershipFailure: new Error("attempt lease expired"),
        terminalizeTurnAttempt,
      } as unknown as RuntimeCrashRecoveryCoordinator;
      const dispatcher = createDispatcher(1, 0, crashRecovery);
      const session = createActiveSession({
        turnActive: true,
        traceRunId: "run-ownership-loss",
        currentTraceTurnId: "turn-ownership-loss",
        currentTraceTurnStartedAt: Date.now() - 1_000,
        currentTraceTurnTerminalRecorded: false,
        currentCrashRecoveryAttemptId: undefined,
        currentCrashRecoveryTerminal: undefined,
      });
      dispatcher.streamingSessions.set(sessionName, session);

      expect(dispatcher.abortSession(sessionName, { reason: "ownership_lost" })).toBe(true);

      expect(terminalizeTurnAttempt).not.toHaveBeenCalled();
      expect(session.currentCrashRecoveryTerminal).toBeUndefined();
      expect(session.currentTraceTurnTerminalRecorded).toBe(false);
      expect(getSessionTurn("turn-ownership-loss")).toBeNull();
      expect(
        querySessionTrace({ sessionKey, sessionName }).events.filter((event) => event.eventType.startsWith("turn.")),
      ).toHaveLength(0);
    } finally {
      await cleanupIsolatedRaviState(stateDir);
    }
  });

  it("reuses a provider terminal fence when an abort races before the canonical trace write", async () => {
    const stateDir = await createIsolatedRaviState("ravi-runtime-dispatcher-terminal-race-");
    try {
      const sessionKey = "agent:dev:test:terminal-race";
      const sessionName = "terminal-race";
      const completedAt = Date.now() - 50;
      getOrCreateSession(sessionKey, "dev", stateDir, { name: sessionName });
      const terminalizeTurnAttempt = mock(() => {
        throw new Error("dispatcher must not terminalize an attempt after the provider won");
      });
      const crashRecovery = {
        acceptingDeliveries: true,
        ownershipFailure: null,
        getActiveTurnAttempt: (attemptId: string) => ({
          attemptId,
          startedTool: false,
          materializedOutput: false,
        }),
        terminalizeTurnAttempt,
      } as unknown as RuntimeCrashRecoveryCoordinator;
      const dispatcher = createDispatcher(1, 0, crashRecovery);
      const session = createActiveSession({
        traceRunId: "run-terminal-race",
        currentTraceTurnId: "turn-terminal-race",
        currentTraceTurnStartedAt: completedAt - 1_000,
        currentTraceTurnTerminalRecorded: false,
        currentCrashRecoveryTerminal: {
          status: "complete",
          completedAt,
          startedTool: false,
          materializedOutput: false,
        },
      });
      dispatcher.streamingSessions.set(sessionName, session);

      expect(dispatcher.abortSession(sessionName, { reason: "late_abort" })).toBe(true);

      expect(terminalizeTurnAttempt).not.toHaveBeenCalled();
      expect(getSessionTurn("turn-terminal-race")).toMatchObject({
        status: "complete",
        completedAt,
        abortReason: null,
      });
      const trace = querySessionTrace({ sessionKey, sessionName });
      expect(trace.events.filter((event) => event.eventType === "turn.complete")).toHaveLength(1);
      expect(trace.events.filter((event) => event.eventType === "turn.interrupted")).toHaveLength(0);
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

  it("restarts only independent successors when a model change races a completed turn drain", async () => {
    const stateDir = await createIsolatedRaviState("ravi-runtime-dispatcher-complete-model-change-");
    try {
      const sessionKey = "agent:dev:test:complete-model-change";
      const sessionName = "complete-model-change";
      getOrCreateSession(sessionKey, "dev", stateDir, { name: sessionName });
      const dispatcher = createDispatcher(1);
      const restartedPrompts: RuntimeLaunchPrompt[] = [];
      let interrupted = false;
      dispatcher.startStreamingSession = mock(async (restartedName, prompt) => {
        expect(restartedName).toBe(sessionName);
        restartedPrompts.push(prompt);
      });
      const completed = createQueuedRuntimeUserMessage({ prompt: "already completed" });
      const successor = createQueuedRuntimeUserMessage({ prompt: "independent successor" });
      dispatcher.streamingSessions.set(
        sessionName,
        createActiveSession({
          turnActive: true,
          pendingMessages: [completed, successor],
          currentTurnPendingIds: completed.pendingId ? [completed.pendingId] : [],
          currentCrashRecoveryTerminal: {
            status: "complete",
            completedAt: Date.now(),
            startedTool: false,
            materializedOutput: false,
          },
          toolEffectFence: "host_write_ahead",
          queryHandle: {
            provider: "codex",
            events: (async function* () {})(),
            interrupt: async () => {
              interrupted = true;
            },
          },
        }),
      );

      const result = await dispatcher.applySessionModelChange(sessionName, "next-model", {
        restartStashedMessages: true,
      });

      expect(result).toBe("restart-next-turn");
      expect(interrupted).toBe(true);
      expect(restartedPrompts.map((prompt) => prompt.prompt)).toEqual(["independent successor"]);
      expect(dispatcher.stashedMessages.get(sessionName)?.map((message) => message.pendingId)).toEqual([
        successor.pendingId,
      ]);
    } finally {
      await cleanupIsolatedRaviState(stateDir);
    }
  });

  it("does not replay an unfenced Codex thread prompt after an external model change", async () => {
    const stateDir = await createIsolatedRaviState("ravi-runtime-dispatcher-thread-model-change-");
    try {
      const sessionKey = "agent:dev:slack:test:group:C123:thread:1784907646.950319";
      const sessionName = "dev-t-1784907646950319";
      getOrCreateSession(sessionKey, "dev", stateDir, { name: sessionName });
      const terminalizeTurnAttempt = mock((input: { status: "interrupted"; completedAt: number }) => ({
        status: input.status,
        completedAt: input.completedAt,
      }));
      const crashRecovery = {
        acceptingDeliveries: true,
        ownershipFailure: null,
        getActiveTurnAttempt: (attemptId: string) => ({
          attemptId,
          startedTool: false,
          materializedOutput: false,
        }),
        terminalizeTurnAttempt,
      } as unknown as RuntimeCrashRecoveryCoordinator;
      const dispatcher = createDispatcher(1, 0, crashRecovery);
      const restartedPrompts: RuntimeLaunchPrompt[] = [];
      let interrupted = false;
      dispatcher.startStreamingSession = mock(async (restartedName, prompt) => {
        expect(restartedName).toBe(sessionName);
        restartedPrompts.push(prompt);
        dispatcher.streamingSessions.set(
          sessionName,
          createActiveSession({
            currentModel: "next-model",
          }),
        );
      });
      dispatcher.streamingSessions.set(
        sessionName,
        createActiveSession({
          turnActive: true,
          traceRunId: "run-thread-model-change",
          currentTraceTurnId: "turn-thread-model-change",
          currentTraceTurnStartedAt: Date.now() - 1_000,
          currentTraceTurnTerminalRecorded: false,
          currentCrashRecoveryAttemptId: "attempt-thread-model-change",
          pendingMessages: [
            createQueuedRuntimeUserMessage({
              prompt: "continue this thread",
              source: {
                channel: "slack",
                accountId: "test",
                chatId: "C123",
                threadId: "1784907646.950319",
                sourceMessageId: "1784907662.660409",
              },
              _agentId: "dev",
            }),
          ],
          queryHandle: {
            provider: "codex",
            events: (async function* () {})(),
            interrupt: async () => {
              interrupted = true;
            },
          },
        }),
      );

      const result = await dispatcher.applySessionModelChange(sessionName, "next-model", {
        restartStashedMessages: true,
      });

      expect(result).toBe("restart-next-turn");
      expect(interrupted).toBe(true);
      expect(terminalizeTurnAttempt).toHaveBeenCalledWith(
        expect.objectContaining({
          attemptId: "attempt-thread-model-change",
          status: "interrupted",
        }),
      );
      expect(restartedPrompts).toEqual([]);
      expect(dispatcher.stashedMessages.get(sessionName)).toBeUndefined();

      const trace = querySessionTrace({ sessionKey, sessionName });
      const modelRestartEvents = trace.events.filter((event) =>
        ["dispatch.restart_requested", "turn.interrupted"].includes(event.eventType),
      );
      expect(modelRestartEvents.map((event) => event.eventType)).toEqual([
        "dispatch.restart_requested",
        "turn.interrupted",
      ]);
      expect(modelRestartEvents.every((event) => event.sessionKey === sessionKey)).toBe(true);
      expect(modelRestartEvents.map((event) => (event.payloadJson as { reason?: string } | null)?.reason)).toEqual([
        "model_change_restart",
        "model_change_restart",
      ]);
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
