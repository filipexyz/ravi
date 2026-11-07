import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as channelRuntime from "../channels/runtime-events.js";
import {
  acceptChannelIngress,
  channelOutputSinks,
  setChannelBackendPromptPublisherForTests,
  type ChannelOutputEnvelope,
} from "../channels/backend.js";
import { attachChatToSession, getOrCreateSession } from "../router/index.js";
import {
  dbGetChannelBackendRuntimeState,
  dbGetDaemonRestartPendingMessages,
  dbUpsertChat,
  dbUpsertDaemonRestartEpoch,
  getDb,
} from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  createCapacityRetryCancellationHandler,
  createCapacityRetryExhaustionHandler,
} from "./capacity-retry-exhaustion.js";
import type { RuntimeCrashRecoveryCoordinator } from "./crash-recovery.js";
import { createRuntimeCredential, reserveRuntimeCredentialAttempt } from "./credential-store.js";
import type { RuntimeCredentialAttemptBinding } from "./credential-types.js";
import { createQueuedRuntimeUserMessage, createRuntimeMessageGenerator } from "./delivery-queue.js";
import type { RuntimeHostStreamingSession, RuntimeUserMessage } from "./host-session.js";
import type { ChannelBackendPromptMetadata, RuntimeLaunchPrompt } from "./message-types.js";
import type { ModelBrokerAttemptFeedback } from "./model-broker.js";
import { registerModelBroker, unregisterModelBroker } from "./model-broker-registry.js";
import { PROVIDER_CAPACITY_EXHAUSTED_MESSAGE, PROVIDER_CAPACITY_EXHAUSTED_REASON } from "./provider-capacity-retry.js";
import { buildSessionRelayTurnOrigin } from "./turn-origin.js";
import { RuntimeSessionDispatcher } from "./session-dispatcher.js";

let stateDir: string | null = null;
let restoreProjection: (() => void) | undefined;
let brokerRegistered = false;
const cleanupChannelSinks: Array<() => void> = [];

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-capacity-expiry-");
});

afterEach(async () => {
  restoreProjection?.();
  restoreProjection = undefined;
  if (brokerRegistered) unregisterModelBroker("expiry-test");
  brokerRegistered = false;
  for (const unregister of cleanupChannelSinks.splice(0)) unregister();
  setChannelBackendPromptPublisherForTests();
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function harness(name = "capacity-expiry", mode?: "sentinel") {
  const session = getOrCreateSession(`agent:main:${name}`, "main", "/tmp/capacity", { name });
  const streaming: RuntimeHostStreamingSession = {
    agentId: "main",
    queryHandle: { provider: "codex", events: (async function* () {})(), interrupt: async () => {} },
    starting: false,
    abortController: new AbortController(),
    pushMessage: null,
    pendingWake: false,
    pendingMessages: [],
    currentModel: "gpt-test",
    toolRunning: false,
    lastActivity: Date.now(),
    done: false,
    interrupted: false,
    turnActive: false,
    compacting: false,
    onTurnComplete: null,
    currentToolSafety: null,
    pendingAbort: false,
  };
  const emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];
  const terminalized: string[] = [];
  const options = {
    sessionName: name,
    session,
    agent: { id: "main", mode },
    runId: "expiry-run",
    runtimeProviderId: "codex" as const,
    instanceId: "expiry-instance",
    streamingSession: streaming,
    crashRecovery: {
      terminalizeTurnAttempt(input: { attemptId: string; status: string; completedAt: number }) {
        terminalized.push(input.attemptId);
        return { ...input, startedTool: false, materializedOutput: false };
      },
    } as unknown as RuntimeCrashRecoveryCoordinator,
    safeEmit: async (topic: string, data: Record<string, unknown>) => {
      emitted.push({ topic, data });
    },
  };
  const handler = createCapacityRetryExhaustionHandler(options);
  const cancelled = createCapacityRetryCancellationHandler(options);
  return { session, streaming, emitted, terminalized, handler, cancelled, crashRecovery: options.crashRecovery };
}

function attach(h: ReturnType<typeof harness>, suffix: string, setOutputTarget = true) {
  const chat = dbUpsertChat({
    channel: "whatsapp",
    instanceId: "expiry",
    platformChatId: `${suffix}@s.whatsapp.net`,
    chatType: "dm",
  });
  attachChatToSession({ sessionKey: h.session.sessionKey, chatId: chat.id, setOutputTarget });
  return { channel: "whatsapp", accountId: "expiry", chatId: chat.platformChatId, canonicalChatId: chat.id };
}

async function expire(h: ReturnType<typeof harness>, prompt: RuntimeLaunchPrompt) {
  await h.handler({
    deliverableMessages: [createQueuedRuntimeUserMessage(prompt)],
    reason: PROVIDER_CAPACITY_EXHAUSTED_REASON,
    error: PROVIDER_CAPACITY_EXHAUSTED_MESSAGE,
  });
}

function responses(h: ReturnType<typeof harness>) {
  return h.emitted.filter((event) => event.topic.endsWith(".response"));
}

function brokerBinding(sessionKey: string, suffix = "expired"): RuntimeCredentialAttemptBinding {
  return {
    credentialId: "broker-credential",
    attemptId: `attempt-${suffix}`,
    authMethod: "model-broker",
    modelBrokerId: "expiry-test",
    modelBrokerLeaseId: `lease-${suffix}`,
    modelBrokerRuntimeId: "runtime-test",
    modelBrokerSessionKey: sessionKey,
    modelBrokerTurnId: `turn-${suffix}`,
    label: "test",
    fingerprint: "test",
    runtimeProvider: "codex",
    resolvedEnv: {},
    sensitiveEnvKeys: [],
    remoteForwardEnvKeys: [],
    bindings: [],
  };
}

function installBroker(feedback: ModelBrokerAttemptFeedback[], fail = false) {
  registerModelBroker("expiry-test", () => ({
    id: "expiry-test",
    resolveRoute: async () => {
      throw new Error("This test does not call route resolution");
    },
    reportAttempt: async (input) => {
      feedback.push(input);
      if (fail) throw new Error("broker feedback unavailable");
      return { recorded: true, nextAction: "retain" };
    },
  }));
  brokerRegistered = true;
}

describe("capacity retry exhaustion delivery", () => {
  it("projects a channel backend error once without legacy response duplication", async () => {
    const h = harness();
    const source = attach(h, "backend");
    const projected = spyOn(channelRuntime, "projectChannelRuntimeEvent").mockResolvedValue([]);
    restoreProjection = () => projected.mockRestore();
    const metadata = { binding: { turnId: "channel-turn" } } as ChannelBackendPromptMetadata;
    await expire(h, { prompt: "expired", source, _channelBackend: metadata });
    expect(projected).toHaveBeenCalledTimes(1);
    expect(projected.mock.calls[0]?.[0]).toMatchObject({
      metadata,
      event: { type: "turn.failed", error: PROVIDER_CAPACITY_EXHAUSTED_MESSAGE },
    });
    expect(responses(h)).toHaveLength(0);
    expect(h.emitted).toHaveLength(1);
  });

  for (const kind of ["cli", "observation", "observer session", "sentinel"] as const) {
    it(`keeps ${kind} expiry off the attached chat even before turn setup`, async () => {
      const h = harness(
        kind === "observer session" ? "obs:capacity" : "capacity",
        kind === "sentinel" ? "sentinel" : undefined,
      );
      const source = attach(h, "private");
      h.streaming.currentReplyTarget = source;
      h.streaming.suppressChatEmit = false;
      await expire(h, {
        prompt: "expired private work",
        source,
        ...(kind === "cli" ? { _cliDestination: true } : {}),
        ...(kind === "observation" ? { _observation: {} as NonNullable<RuntimeLaunchPrompt["_observation"]> } : {}),
      });
      expect(responses(h)).toHaveLength(0);
      expect(h.emitted[0]?.data).toMatchObject({ type: "turn.failed", failureKind: "provider_capacity_exhausted" });
    });
  }

  it("delivers to the expired inbound chat instead of stale current-turn output", async () => {
    const h = harness();
    h.streaming.currentReplyTarget = attach(h, "other-default");
    const source = attach(h, "original-input", false);
    await expire(h, { prompt: "expired", source });
    expect(responses(h)).toHaveLength(1);
    expect(responses(h)[0]?.data.target).toMatchObject({ chatId: source.chatId });
  });

  it("uses the attached default for a relay without inheriting its leftover source", async () => {
    const h = harness();
    const target = attach(h, "default-output");
    h.session.lastChannel = "whatsapp";
    h.session.lastTo = "unrelated@s.whatsapp.net";
    await expire(h, {
      prompt: "expired relay",
      source: { channel: "whatsapp", accountId: "expiry", chatId: "unrelated@s.whatsapp.net" },
      _turnOrigin: buildSessionRelayTurnOrigin("execute"),
    });
    expect(responses(h)).toHaveLength(1);
    expect(responses(h)[0]?.data.target).toMatchObject({ chatId: target.chatId });
  });

  it("fails closed for an unattached inbound rather than leaking to the default", async () => {
    const h = harness();
    h.streaming.currentReplyTarget = attach(h, "default-output");
    await expire(h, {
      prompt: "expired",
      source: { channel: "whatsapp", accountId: "expiry", chatId: "unattached@s.whatsapp.net" },
    });
    expect(responses(h)).toHaveLength(0);
  });
});

describe("capacity retry exhaustion credential settlement", () => {
  for (const timing of ["before preparation", "after preparation"] as const) {
    it(`settles the broker lease ${timing} before the successor obtains its own attempt`, async () => {
      const h = harness();
      const feedback: ModelBrokerAttemptFeedback[] = [];
      installBroker(feedback);
      const expiredBinding = brokerBinding(h.session.sessionKey);
      h.streaming.currentRuntimeCredential = expiredBinding;
      const retry = createQueuedRuntimeUserMessage({ prompt: "expired" });
      retry.providerCapacityRetry = { startedAt: 1_000, retries: 3, notBefore: 2_000 };
      const successor = createQueuedRuntimeUserMessage({ prompt: "successor" });
      h.streaming.pendingMessages = [retry, successor];
      let now = timing === "before preparation" ? 31_000 : 2_000;
      const generator = createRuntimeMessageGenerator({
        sessionName: h.session.name!,
        session: h.streaming,
        stashedMessages: new Map(),
        capacityRetryRuntime: { now: () => now },
        onCapacityRetryExhausted: h.handler,
        traceTurnStart: ({ combinedPrompt }) => {
          if (combinedPrompt === "expired") {
            h.streaming.currentCrashRecoveryAttemptId = "durable-expired";
            h.streaming.currentTraceTurnId = "turn-expired";
            now = 31_000;
          } else {
            expect(feedback).toHaveLength(1);
            expect(expiredBinding.modelBrokerAttemptTerminal).toBe(true);
            h.streaming.currentRuntimeCredential = brokerBinding(h.session.sessionKey, "successor");
          }
          return undefined;
        },
      });
      const input = await generator.next();
      expect(input.value?.message.content).toBe("successor");
      expect(feedback).toEqual([
        expect.objectContaining({
          attemptId: "attempt-expired",
          leaseId: "lease-expired",
          turnId: "turn-expired",
          outcome: "abandoned",
          effectState: "none",
          failureKind: PROVIDER_CAPACITY_EXHAUSTED_REASON,
        }),
      ]);
      expect(h.streaming.currentRuntimeCredential?.attemptId).toBe("attempt-successor");
      expect(h.terminalized).toEqual(timing === "after preparation" ? ["durable-expired"] : []);
      h.streaming.done = true;
      h.streaming.onTurnComplete?.();
      await generator.return(undefined);
    });
  }

  it("closes the stored credential attempt and allocates a distinct successor attempt", async () => {
    const h = harness();
    createRuntimeCredential({
      id: "capacity-credential",
      label: "capacity",
      runtimeProvider: "codex",
      authMethod: "env",
      bindings: [
        {
          sourceKind: "env",
          targetKind: "env",
          targetName: "OPENAI_API_KEY",
          secretRef: "env:RAVI_TEST_CAPACITY_KEY",
          sensitive: true,
          remoteForward: false,
        },
      ],
    });
    const oldAttempt = reserveRuntimeCredentialAttempt({
      credentialId: "capacity-credential",
      runtimeProvider: "codex",
      sessionKey: h.session.sessionKey,
      turnId: "expired-turn",
    });
    const binding = {
      ...brokerBinding(h.session.sessionKey),
      credentialId: "capacity-credential",
      authMethod: "env",
      attemptId: oldAttempt,
    };
    h.streaming.currentRuntimeCredential = binding;
    const retry = createQueuedRuntimeUserMessage({ prompt: "expired" });
    retry.providerCapacityRetry = { startedAt: 1_000, retries: 3, notBefore: 2_000 };
    h.streaming.pendingMessages = [retry, createQueuedRuntimeUserMessage({ prompt: "successor" })];
    let now = 2_000;
    const generator = createRuntimeMessageGenerator({
      sessionName: h.session.name!,
      session: h.streaming,
      stashedMessages: new Map(),
      capacityRetryRuntime: { now: () => now },
      onCapacityRetryExhausted: h.handler,
      traceTurnStart: ({ combinedPrompt }) => {
        if (combinedPrompt === "expired") {
          h.streaming.currentCrashRecoveryAttemptId = "expired-durable";
          h.streaming.currentTraceTurnId = "expired-turn";
          now = 31_000;
        } else {
          expect(binding.attemptId).toBeUndefined();
          binding.attemptId = reserveRuntimeCredentialAttempt({
            credentialId: binding.credentialId,
            runtimeProvider: "codex",
            sessionKey: h.session.sessionKey,
            turnId: "successor-turn",
          });
        }
        return undefined;
      },
    });
    const delivered = await generator.next();
    expect(delivered.value?.message.content).toBe("successor");
    expect(
      getDb().prepare("SELECT status, turn_id FROM runtime_credential_attempts WHERE id = ?").get(oldAttempt),
    ).toEqual({ status: "abandoned", turn_id: "expired-turn" });
    expect(binding.attemptId).not.toBe(oldAttempt);
    expect(
      getDb().prepare("SELECT status, turn_id FROM runtime_credential_attempts WHERE id = ?").get(binding.attemptId),
    ).toEqual({ status: "reserved", turn_id: "successor-turn" });
    h.streaming.done = true;
    h.streaming.onTurnComplete?.();
    await generator.return(undefined);
  });

  it("does not report an already terminal broker lease again", async () => {
    const h = harness();
    const feedback: ModelBrokerAttemptFeedback[] = [];
    installBroker(feedback);
    h.streaming.currentRuntimeCredential = { ...brokerBinding(h.session.sessionKey), modelBrokerAttemptTerminal: true };
    await expire(h, { prompt: "expired" });
    expect(feedback).toEqual([]);
  });

  it("reports capacity exhaustion without advancing past failed broker settlement", async () => {
    const h = harness();
    const feedback: ModelBrokerAttemptFeedback[] = [];
    installBroker(feedback, true);
    h.streaming.currentRuntimeCredential = brokerBinding(h.session.sessionKey);
    await expect(expire(h, { prompt: "expired" })).rejects.toThrow("broker feedback unavailable");
    expect(h.streaming.currentRuntimeCredential.modelBrokerAttemptTerminal).not.toBe(true);
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0]?.data).toMatchObject({
      type: "turn.failed",
      failureKind: "provider_capacity_exhausted",
      error: PROVIDER_CAPACITY_EXHAUSTED_MESSAGE,
    });
  });

  for (const delivery of ["backend", "legacy"] as const) {
    it(`delivers ${delivery} exhaustion after preparation even when broker feedback fails`, async () => {
      const h = harness();
      const source = attach(h, "feedback-failed");
      const feedback: ModelBrokerAttemptFeedback[] = [];
      installBroker(feedback, true);
      h.streaming.currentRuntimeCredential = brokerBinding(h.session.sessionKey);
      const metadata = { binding: { turnId: "channel-expired" } } as ChannelBackendPromptMetadata;
      const projected = spyOn(channelRuntime, "projectChannelRuntimeEvent").mockResolvedValue([]);
      restoreProjection = () => projected.mockRestore();
      const retry = createQueuedRuntimeUserMessage({
        prompt: "expired",
        source,
        ...(delivery === "backend" ? { _channelBackend: metadata } : {}),
      });
      retry.providerCapacityRetry = { startedAt: 1_000, retries: 3, notBefore: 2_000 };
      const successor = createQueuedRuntimeUserMessage({ prompt: "successor" });
      h.streaming.pendingMessages = [retry, successor];
      let now = 2_000;
      const prepared: string[] = [];
      const generator = createRuntimeMessageGenerator({
        sessionName: h.session.name!,
        session: h.streaming,
        stashedMessages: new Map(),
        capacityRetryRuntime: { now: () => now },
        onCapacityRetryExhausted: h.handler,
        traceTurnStart: ({ combinedPrompt }) => {
          prepared.push(combinedPrompt);
          h.streaming.currentCrashRecoveryAttemptId = "durable-expired";
          h.streaming.currentTraceTurnId = "turn-expired";
          now = 31_000;
          return undefined;
        },
      });
      await expect(generator.next()).rejects.toThrow("broker feedback unavailable");
      expect(prepared).toEqual(["expired"]);
      expect(h.streaming.pendingMessages).toEqual([successor]);
      expect(h.terminalized).toEqual(["durable-expired"]);
      expect(h.streaming.currentRuntimeCredential.modelBrokerAttemptTerminal).not.toBe(true);
      expect(h.emitted.filter(({ data }) => data.type === "turn.failed")).toHaveLength(1);
      if (delivery === "backend") {
        expect(projected).toHaveBeenCalledTimes(1);
        expect(projected.mock.calls[0]?.[0]).toEqual({
          metadata,
          event: { type: "turn.failed", error: PROVIDER_CAPACITY_EXHAUSTED_MESSAGE, recoverable: false },
        });
        expect(responses(h)).toHaveLength(0);
      } else {
        expect(projected).not.toHaveBeenCalled();
        expect(responses(h)).toHaveLength(1);
        expect(responses(h)[0]?.data.target).toMatchObject({ chatId: source.chatId });
      }
    });
  }
});

describe("restored capacity cancellation delivery", () => {
  it("detaches a saved handoff before failed broker feedback can enter the finalizer", async () => {
    const h = harness();
    const feedback: ModelBrokerAttemptFeedback[] = [];
    installBroker(feedback, true);
    const metadata = { binding: { turnId: "saved-logical-turn" } } as ChannelBackendPromptMetadata;
    h.streaming.currentChannelBackend = metadata;
    h.streaming.currentRuntimeCredential = brokerBinding(h.session.sessionKey);
    h.streaming.capacityRetrySnapshotSaved = true;
    h.streaming.internalAbortReason = "shutdown_all";
    const projected = spyOn(channelRuntime, "projectChannelRuntimeEvent").mockResolvedValue([]);
    restoreProjection = () => projected.mockRestore();
    await expect(
      h.cancelled({
        deliverableMessages: [createQueuedRuntimeUserMessage({ prompt: "saved", _channelBackend: metadata })],
      }),
    ).rejects.toThrow("broker feedback unavailable");
    expect(h.streaming.currentChannelBackend).toBeUndefined();
    expect(projected).not.toHaveBeenCalled();
    expect(h.emitted).toEqual([]);
    expect(h.streaming.currentRuntimeCredential.modelBrokerAttemptTerminal).not.toBe(true);
  });

  for (const cancellation of ["explicit abort", "superseded", "unsaved shutdown"] as const) {
    it(`does not preserve logical work for ${cancellation}`, async () => {
      const h = harness();
      const metadata = { binding: { turnId: "cancelled-logical-turn" } } as ChannelBackendPromptMetadata;
      h.streaming.currentChannelBackend = metadata;
      h.streaming.capacityRetrySnapshotSaved = cancellation !== "unsaved shutdown";
      h.streaming.internalAbortReason = cancellation === "explicit abort" ? "explicit_abort" : "shutdown_all";
      h.streaming.currentTurnSuperseded = cancellation === "superseded";
      const projected = spyOn(channelRuntime, "projectChannelRuntimeEvent").mockResolvedValue([]);
      restoreProjection = () => projected.mockRestore();
      await h.cancelled({
        deliverableMessages: [createQueuedRuntimeUserMessage({ prompt: "cancelled", _channelBackend: metadata })],
      });
      expect(projected).toHaveBeenCalledTimes(1);
      expect(projected.mock.calls[0]?.[0]).toEqual({ metadata, event: { type: "turn.interrupted" } });
      expect(h.emitted[0]?.data.type).toBe("turn.interrupted");
    });
  }

  it("preserves the real channel turn across snapshot, shutdown and restored completion", async () => {
    const h = harness("capacity-channel-handoff");
    setChannelBackendPromptPublisherForTests(async () => {});
    const accepted = await acceptChannelIngress({
      protocol: "ravi.channel.backend",
      schemaVersion: 1,
      requestId: "capacity-ingress",
      idempotencyKey: "capacity-ingress-idem",
      localActorId: "capacity-actor",
      channelInstanceId: "capacity-instance",
      agentId: "main",
      external: {
        channelKind: "custom",
        connectionId: "capacity-connection",
        conversationId: "capacity-chat",
        senderId: "capacity-sender",
        messageId: "capacity-message",
      },
      content: [{ type: "text", text: "capacity original input" }],
      receivedAt: new Date().toISOString(),
    });
    if (!accepted.binding) throw new Error("Expected accepted channel fixture");
    const metadata: ChannelBackendPromptMetadata = {
      protocol: "ravi.channel.backend",
      schemaVersion: 1,
      ingressRequestId: "capacity-ingress",
      correlationId: "capacity-ingress",
      binding: accepted.binding,
      target: { channelKind: "custom", connectionId: "capacity-connection", conversationId: "capacity-chat" },
    };
    const events: channelRuntime.KnownChannelRuntimeEvent[] = [];
    const outputs: ChannelOutputEnvelope[] = [];
    cleanupChannelSinks.push(
      channelRuntime.channelRuntimeEventSinks.register(metadata.target, {
        emit: async (event) => {
          events.push(event);
        },
      }),
    );
    cleanupChannelSinks.push(
      channelOutputSinks.register(metadata.target, {
        emit: async (output) => {
          outputs.push(output);
        },
      }),
    );
    await channelRuntime.projectChannelRuntimeEvent({ metadata, event: { type: "text.delta", text: "" } });
    expect(dbGetChannelBackendRuntimeState(metadata.binding.turnId)?.state).toBe("running");

    const startedAt = Date.now();
    const retry = createQueuedRuntimeUserMessage({ prompt: "capacity original input", _channelBackend: metadata });
    retry.clientMessageId = "previous-failed-physical-attempt";
    retry.providerCapacityRetry = { startedAt, retries: 2, notBefore: startedAt + 12_000 };
    h.streaming.pendingMessages = [retry];
    h.streaming.currentChannelBackend = metadata;
    const dispatcher = new RuntimeSessionDispatcher({
      instanceId: "handoff-test",
      maxConcurrentSessions: 1,
      interactiveReservedSessions: 0,
      safeEmit: async () => {},
      notifyRuntimeRecoveryExhausted: async () => {},
      getConfigModel: () => "gpt-test",
      crashRecovery: { ...h.crashRecovery, acceptingDeliveries: true } as RuntimeCrashRecoveryCoordinator,
    });
    dispatcher.streamingSessions.set(h.session.name!, h.streaming);
    dbUpsertDaemonRestartEpoch({ restartEpoch: "capacity-handoff", reason: "test", createdAt: startedAt });
    const oldGenerator = createRuntimeMessageGenerator({
      sessionName: h.session.name!,
      session: h.streaming,
      stashedMessages: new Map(),
      onCapacityRetryCancelled: h.cancelled,
      capacityRetryRuntime: {
        now: () => startedAt + 4_000,
        wait: async () => {
          expect(
            dispatcher.recordDaemonRestartSnapshot({
              restartEpoch: "capacity-handoff",
              reason: "test",
              stoppedAt: startedAt + 4_000,
            }),
          ).toBe(1);
          expect(h.streaming.capacityRetrySnapshotSaved).toBe(true);
          dispatcher.shutdownAll();
        },
      },
    });
    expect(await oldGenerator.next()).toEqual({ done: true, value: undefined });
    expect(dbGetChannelBackendRuntimeState(metadata.binding.turnId)?.state).toBe("running");
    expect(h.streaming.currentChannelBackend).toBeUndefined();
    expect(events.filter((event) => event.kind === "turn.terminal_output")).toEqual([]);
    expect(h.emitted).toEqual([]);

    const pending = dbGetDaemonRestartPendingMessages("capacity-handoff", h.session.sessionKey) as RuntimeUserMessage[];
    expect(pending).toHaveLength(1);
    const restored = harness("capacity-channel-handoff");
    restored.streaming.pendingMessages = pending;
    let now = startedAt + 6_000;
    const waits: number[] = [];
    const newGenerator = createRuntimeMessageGenerator({
      sessionName: restored.session.name!,
      session: restored.streaming,
      stashedMessages: new Map(),
      capacityRetryRuntime: {
        now: () => now,
        wait: async (delay) => {
          waits.push(delay);
          now += delay;
        },
      },
    });
    expect((await newGenerator.next()).value?.message.content).toBe("capacity original input");
    expect(waits).toEqual([6_000]);
    const restoredMetadata = pending[0]?.launchPrompt?._channelBackend;
    if (!restoredMetadata) throw new Error("Expected persisted channel identity");
    await channelRuntime.projectChannelRuntimeEvent({
      metadata: restoredMetadata,
      event: { type: "turn.complete", usage: { inputTokens: 0, outputTokens: 0 } },
      responseText: "resumed exactly once",
    });
    expect(dbGetChannelBackendRuntimeState(metadata.binding.turnId)?.state).toBe("completed");
    expect(events.filter((event) => event.kind === "turn.terminal_output")).toHaveLength(1);
    expect(outputs).toHaveLength(1);
    expect(JSON.stringify(outputs)).toContain("resumed exactly once");
    restored.streaming.done = true;
    restored.streaming.onTurnComplete?.();
    await newGenerator.return(undefined);
  });

  for (const phase of ["waiting", "prepared"] as const) {
    it(`terminalizes only the original channel request when cancelled while ${phase}`, async () => {
      const h = harness();
      const source = attach(h, "cancelled-input", false);
      h.streaming.currentReplyTarget = attach(h, "successor-output");
      const feedback: ModelBrokerAttemptFeedback[] = [];
      installBroker(feedback);
      h.streaming.currentRuntimeCredential = brokerBinding(h.session.sessionKey);
      const projected = spyOn(channelRuntime, "projectChannelRuntimeEvent").mockResolvedValue([]);
      restoreProjection = () => projected.mockRestore();
      if (phase === "prepared") h.streaming.currentCrashRecoveryAttemptId = "prepared-before-cancel";
      const metadata = { binding: { turnId: "original-logical-turn" } } as ChannelBackendPromptMetadata;
      await h.cancelled({
        deliverableMessages: [
          createQueuedRuntimeUserMessage({ prompt: "cancelled", source, _channelBackend: metadata }),
        ],
      });
      expect(projected).toHaveBeenCalledTimes(phase === "waiting" ? 1 : 0);
      if (phase === "waiting") {
        expect(projected.mock.calls[0]?.[0]).toEqual({ metadata, event: { type: "turn.interrupted" } });
        expect(h.emitted).toEqual([
          expect.objectContaining({
            topic: `ravi.session.${h.session.name}.runtime`,
            data: expect.objectContaining({
              type: "turn.interrupted",
              _source: expect.objectContaining({ chatId: source.chatId }),
            }),
          }),
        ]);
      } else {
        expect(h.emitted).toEqual([]);
      }
      expect(responses(h)).toEqual([]);
      expect(h.terminalized).toEqual([]);
      expect(h.streaming.currentCrashRecoveryAttemptId).toBe(
        phase === "prepared" ? "prepared-before-cancel" : undefined,
      );
      expect(feedback).toEqual([expect.objectContaining({ outcome: "abandoned", effectState: "none" })]);
      expect(JSON.stringify(h.emitted)).not.toContain(PROVIDER_CAPACITY_EXHAUSTED_MESSAGE);
    });
  }
});
