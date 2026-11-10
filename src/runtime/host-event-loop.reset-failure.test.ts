import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  acceptChannelIngress,
  channelOutputSinks,
  setChannelBackendPromptPublisherForTests,
  type ChannelOutputEnvelope,
} from "../channels/backend.js";
import {
  channelRuntimeEventSinks,
  setChannelRuntimeGenerationIdForTests,
  type KnownChannelRuntimeEvent,
} from "../channels/runtime-events.js";
import { configStore } from "../config-store.js";
import * as pricing from "../costs/pricing-catalog.js";
import { getRecentHistory } from "../db.js";
import { nats } from "../nats.js";
import {
  dbCreateAgent,
  dbGetAgent,
  dbGetChannelBackendRuntimeState,
  dbRecordChannelBackendRuntimeEvent,
  getDb,
} from "../router/router-db.js";
import {
  resolveSession,
  updateRuntimeProviderState,
  updateSessionRuntimeProviderOverride,
} from "../router/sessions.js";
import { querySessionTrace } from "../session-trace/query.js";
import { recordAdapterRequestTrace } from "../session-trace/runtime-trace.js";
import { getSessionTurn, listSessionEventsByTurn } from "../session-trace/session-trace-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { RuntimeCrashRecoveryCoordinator } from "./crash-recovery.js";
import { getRuntimeTurnAttempt } from "./crash-recovery-store.js";
import { createQueuedRuntimeUserMessage } from "./delivery-queue.js";
import { runRuntimeEventLoop } from "./host-event-loop.js";
import type { RuntimeHostStreamingSession, RuntimeUserMessage } from "./host-session.js";
import type { ChannelBackendPromptMetadata, RuntimeLaunchPrompt } from "./message-types.js";
import { RuntimeSessionDispatcher } from "./session-dispatcher.js";
import type { RuntimeCapabilities, RuntimeSessionHandle } from "./types.js";

const RESET_ERROR = "FIXTURE_NATIVE_SESSION_RESET_REFUSED";
const PROVIDER_ERROR = "context window exhausted";
const USAGE = { inputTokens: 13, outputTokens: 5 };
let stateDir: string | null = null;
const cleanups: Array<() => void> = [];

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-host-reset-failure-");
  dbCreateAgent({ id: "agent-a", name: "Reset fixture agent", cwd: stateDir });
  setChannelBackendPromptPublisherForTests(async () => {});
  setChannelRuntimeGenerationIdForTests("fixture-reset-generation");
  const emit = spyOn(nats, "emit").mockImplementation(async () => {});
  const prewarm = spyOn(pricing, "prewarmPricingCatalog").mockImplementation(() => {});
  cleanups.push(
    () => emit.mockRestore(),
    () => prewarm.mockRestore(),
  );
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  setChannelBackendPromptPublisherForTests();
  setChannelRuntimeGenerationIdForTests();
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

async function acceptedMetadata(suffix: string): Promise<ChannelBackendPromptMetadata> {
  const target = { channelKind: "custom", connectionId: "fixture-connection", conversationId: "fixture-chat" };
  const requestId = `fixture-request-${suffix}`;
  const accepted = await acceptChannelIngress({
    protocol: "ravi.channel.backend",
    schemaVersion: 1,
    requestId,
    idempotencyKey: requestId,
    localActorId: "fixture-actor",
    channelInstanceId: "fixture-instance",
    agentId: "agent-a",
    external: { ...target, senderId: "fixture-sender", messageId: `fixture-message-${suffix}` },
    content: [{ type: "text", text: `Fixture request ${suffix}` }],
    receivedAt: "2026-11-04T12:00:00.000Z",
  });
  if (!accepted.binding) throw new Error("Fixture ingress rejected");
  return {
    protocol: "ravi.channel.backend",
    schemaVersion: 1,
    ingressRequestId: requestId,
    correlationId: requestId,
    binding: accepted.binding,
    target,
  };
}

/**
 * Only provider input and external sinks are synthetic. Acceptance, reset,
 * crash-recovery leases, physical trace and logical terminal writes are real.
 * The temporary SQLite trigger rejects the native-id clear, not accounting.
 */
async function fixture(options: { rejectReset?: boolean; initiallyRunning?: boolean; realDispatcher?: boolean } = {}) {
  const metadata = await acceptedMetadata("a");
  const session = resolveSession(metadata.binding.sessionId)!;
  const agent = dbGetAgent(metadata.binding.agentId)!;
  let providerEvents = 0;
  const runtime: RuntimeSessionHandle = {
    provider: "test-provider",
    events: (async function* () {
      providerEvents++;
      yield {
        type: "turn.failed" as const,
        error: PROVIDER_ERROR,
        recoverable: false,
        usage: USAGE,
        rawEvent: { privateDiagnostic: "fixture-private-provider-data" },
      };
    })(),
    async interrupt() {},
  };
  const source = {
    channel: metadata.target.channelKind,
    accountId: metadata.target.connectionId,
    instanceId: metadata.binding.channelInstanceId,
    chatId: metadata.target.conversationId,
    canonicalChatId: metadata.binding.chatId,
    sourceMessageId: metadata.binding.messageId,
  };
  const pending = createQueuedRuntimeUserMessage({
    prompt: "Fixture request a",
    source,
    _agentId: agent.id,
    _channelBackend: metadata,
    deliveryBarrier: "after_response",
  });
  const streaming: RuntimeHostStreamingSession = {
    sessionKey: session.sessionKey,
    agentId: agent.id,
    queryHandle: runtime,
    starting: false,
    abortController: new AbortController(),
    pushMessage: null,
    pendingWake: false,
    pendingMessages: [pending],
    currentTurnPendingIds: [pending.pendingId!],
    currentSource: source,
    currentChannelBackend: metadata,
    currentModel: "fixture-model",
    toolEffectFence: "host_write_ahead",
    toolRunning: false,
    lastActivity: Date.now(),
    done: false,
    interrupted: false,
    turnActive: true,
    compacting: false,
    onTurnComplete: null,
    currentToolSafety: null,
    pendingAbort: false,
    agentMode: "active",
    traceRunId: "fixture-reset-run",
  };
  let clockOffset = 0;
  const recovery = new RuntimeCrashRecoveryCoordinator({
    instanceId: "fixture-reset-instance",
    now: () => Date.now() + clockOffset,
    setInterval: () => ({}),
    clearInterval: () => {},
  });
  recovery.start();
  cleanups.push(() => {
    if (recovery.acceptingDeliveries) recovery.stopGracefully("fixture_finished");
  });
  const trace = recordAdapterRequestTrace({
    sessionKey: session.sessionKey,
    sessionName: session.name!,
    agentId: agent.id,
    runId: streaming.traceRunId!,
    turnId: "fixture-reset-physical-turn",
    provider: runtime.provider,
    model: streaming.currentModel,
    prompt: pending.message.content as string,
    systemPrompt: "Synthetic reset regression",
    cwd: stateDir!,
    resume: true,
    fork: false,
    source,
    hasHooks: false,
    pluginNames: [],
    mcpServerNames: [],
    hasRemoteSpawn: false,
  })!;
  const attempt = recovery.startTurnAttempt({
    turnId: trace.turnId,
    runId: streaming.traceRunId!,
    sessionKey: session.sessionKey,
    sessionName: session.name!,
    agentId: agent.id,
    provider: runtime.provider,
    model: streaming.currentModel,
    startedAt: trace.startedAt,
    requestBlobSha256: trace.requestBlobSha256,
    originKind: "human",
    source,
    deliveryBarrier: "after_response",
    pendingIds: [pending.pendingId!],
  });
  streaming.currentTraceTurnId = trace.turnId;
  streaming.currentTraceTurnStartedAt = trace.startedAt;
  streaming.currentCrashRecoveryAttemptId = attempt.attemptId;
  updateRuntimeProviderState(session.sessionKey, runtime.provider, { providerSessionId: "fixture-native-session" });
  if (options.initiallyRunning !== false) {
    dbRecordChannelBackendRuntimeEvent({
      turnId: metadata.binding.turnId,
      state: "running",
      runtimeGenerationId: "fixture-reset-generation",
    });
  }
  const logicalBefore = dbGetChannelBackendRuntimeState(metadata.binding.turnId);
  const events: KnownChannelRuntimeEvent[] = [];
  const hostEmits: Array<{ topic: string; data: Record<string, unknown> }> = [];
  const outputs: ChannelOutputEnvelope[] = [];
  let runtimeSink: ((event: KnownChannelRuntimeEvent) => Promise<void>) | undefined;
  let outputSink: (() => Promise<void>) | undefined;
  cleanups.push(
    channelRuntimeEventSinks.register(metadata.target, {
      async emit(event) {
        events.push(event);
        await runtimeSink?.(event);
      },
    }),
    channelOutputSinks.register(metadata.target, {
      async emit(output) {
        outputs.push(output);
        await outputSink?.();
      },
    }),
  );
  const dispatcher = options.realDispatcher
    ? new RuntimeSessionDispatcher({
        instanceId: "fixture-reset-instance",
        maxConcurrentSessions: 2,
        interactiveReservedSessions: 0,
        safeEmit: async () => {},
        notifyRuntimeRecoveryExhausted: async () => {},
        getConfigModel: () => "fixture-model",
        crashRecovery: recovery,
      })
    : undefined;
  const live = dispatcher?.streamingSessions ?? new Map<string, RuntimeHostStreamingSession>();
  const stash = dispatcher?.stashedMessages ?? new Map<string, RuntimeUserMessage[]>();
  live.set(session.name!, streaming);
  const restarts: Array<{ sessionName: string; reason: string }> = [];
  let resetRefusals = 0;
  let resetRefusalHook: (() => void) | undefined;
  if (options.rejectReset !== false) {
    const database = getDb();
    const prepare = database.prepare;
    database.prepare = ((...args: Parameters<typeof prepare>) => {
      const statement = Reflect.apply(prepare, database, args);
      if (args[0].includes("history_reset_after_id = ?") && args[0].includes("sdk_session_id = NULL")) {
        // router-db already proxies statements; wrap its run instead of spying
        // on a transient function returned by that proxy's property getter.
        return new Proxy(statement, {
          get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            if (property !== "run") return typeof value === "function" ? value.bind(target) : value;
            return (...bindings: Parameters<typeof statement.run>) => {
              try {
                return Reflect.apply(value, target, bindings);
              } catch (error) {
                if (error instanceof Error && error.message.includes(RESET_ERROR)) {
                  resetRefusals++;
                  resetRefusalHook?.();
                }
                throw error;
              }
            };
          },
        });
      }
      return statement;
    }) as typeof prepare;
    cleanups.push(() => {
      database.prepare = prepare;
    });
    getDb().exec(`CREATE TEMP TRIGGER fixture_refuse_native_session_reset
      BEFORE UPDATE OF sdk_session_id ON sessions
      WHEN OLD.sdk_session_id IS NOT NULL AND NEW.sdk_session_id IS NULL
      BEGIN SELECT RAISE(ABORT, '${RESET_ERROR}'); END`);
  }
  return {
    metadata,
    session,
    streaming,
    runtime,
    recovery,
    pending,
    trace,
    attempt,
    logicalBefore,
    events,
    hostEmits,
    outputs,
    dispatcher,
    live,
    stash,
    restarts,
    providerEvents: () => providerEvents,
    resetRefusals: () => resetRefusals,
    onResetRefusal: (hook: NonNullable<typeof resetRefusalHook>) => {
      resetRefusalHook = hook;
    },
    expireLease: () => {
      clockOffset = 240_000;
    },
    onRuntimeSink: (hook: NonNullable<typeof runtimeSink>) => {
      runtimeSink = hook;
    },
    onOutputSink: (hook: NonNullable<typeof outputSink>) => {
      outputSink = hook;
    },
    run: () =>
      runRuntimeEventLoop({
        runId: streaming.traceRunId!,
        sessionName: session.name!,
        session,
        agent,
        streaming,
        runtimeSession: runtime,
        runtimeCapabilities,
        model: streaming.currentModel!,
        instanceId: "fixture-reset-instance",
        defaultRuntimeProviderId: runtime.provider,
        streamingSessions: live,
        stashedMessages: stash,
        safeEmit: async (topic, data) => {
          hostEmits.push({ topic, data });
        },
        drainPendingStarts: () => {},
        crashRecovery: recovery,
        restartStashedSession: async (input) => {
          restarts.push(input);
        },
      }),
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function successorSession(
  metadata: ChannelBackendPromptMetadata,
  pendingMessages: RuntimeUserMessage[],
): RuntimeHostStreamingSession {
  return {
    sessionKey: resolveSession(metadata.binding.sessionId)!.sessionKey,
    agentId: metadata.binding.agentId,
    queryHandle: { provider: "codex", events: (async function* () {})(), async interrupt() {} },
    starting: false,
    abortController: new AbortController(),
    pushMessage: null,
    pendingWake: false,
    pendingMessages,
    currentTurnPendingIds: pendingMessages.map((message) => message.pendingId!),
    currentSource: {
      channel: metadata.target.channelKind,
      accountId: metadata.target.connectionId,
      instanceId: metadata.binding.channelInstanceId,
      chatId: metadata.target.conversationId,
      canonicalChatId: metadata.binding.chatId,
      sourceMessageId: metadata.binding.messageId,
    },
    currentChannelBackend: metadata,
    currentModel: "fixture-successor-model",
    toolEffectFence: "host_write_ahead",
    toolRunning: false,
    lastActivity: Date.now(),
    done: false,
    interrupted: false,
    turnActive: true,
    compacting: false,
    onTurnComplete: null,
    currentToolSafety: null,
    pendingAbort: false,
    agentMode: "active",
    traceRunId: "fixture-successor-run",
  };
}

function expectPhysicalFailureOnce(f: Fixture): void {
  const physical = getRuntimeTurnAttempt(f.attempt.attemptId);
  expect(physical?.status).toBe("failed");
  expect(getSessionTurn(f.trace.turnId)).toMatchObject({
    status: "failed",
    completedAt: physical!.completedAt,
    ...USAGE,
  });
  const terminals = listSessionEventsByTurn(f.trace.turnId).filter((event) => event.eventType === "turn.failed");
  expect(terminals).toHaveLength(1);
  // Failure diagnostics intentionally omit usage; the turn row above owns accounting.
  expect(terminals[0]?.status).toBe("failed");
  expect(f.providerEvents()).toBe(1);
}

function expectNoRecovery(f: Fixture): void {
  expect(f.resetRefusals()).toBe(1);
  expect(f.stash.size).toBe(0);
  expect(f.restarts).toEqual([]);
  expect(resolveSession(f.session.sessionKey)?.providerSessionId).toBe("fixture-native-session");
}

function expectLogicalFailureOnce(f: Fixture): void {
  expect(dbGetChannelBackendRuntimeState(f.metadata.binding.turnId)?.state).toBe("failed");
  expect(f.events.filter((event) => event.kind === "turn.terminal_output")).toHaveLength(1);
  expect(f.outputs).toHaveLength(1);
  expect(f.outputs[0]).toMatchObject({ kind: "safe_error", binding: f.metadata.binding });
  const external = JSON.stringify([f.events, f.outputs]);
  for (const privateText of [RESET_ERROR, PROVIDER_ERROR, "fixture-private-provider-data", "fixture-native-session"]) {
    expect(external).not.toContain(privateText);
  }
}

describe("host context-recovery reset failure", () => {
  for (const initiallyRunning of [true, false]) {
    it(`settles the accepted logical request after real reset failure (running=${initiallyRunning})`, async () => {
      const f = await fixture({ initiallyRunning });
      await expect(f.run()).rejects.toThrow(RESET_ERROR);
      expectLogicalFailureOnce(f);
      expectPhysicalFailureOnce(f);
      expectNoRecovery(f);
      expect(f.events.map((event) => event.kind)).toEqual(
        initiallyRunning ? ["turn.terminal_output"] : ["turn.state_changed", "turn.terminal_output"],
      );
      expect(f.streaming.done).toBe(true);
      expect(f.live.has(f.session.name!)).toBe(false);
    });
  }

  for (const sink of ["runtime", "output"] as const) {
    it(`preserves the reset exception when the ${sink} sink also rejects`, async () => {
      const f = await fixture();
      const reject = async () => {
        throw new Error("fixture secondary sink failure");
      };
      if (sink === "runtime") f.onRuntimeSink(reject);
      else f.onOutputSink(reject);
      await expect(f.run()).rejects.toThrow(RESET_ERROR);
      expectLogicalFailureOnce(f);
      expectPhysicalFailureOnce(f);
      expectNoRecovery(f);
    });
  }

  it("preserves the real reset exception when the initial projection guard throws", async () => {
    const f = await fixture();
    let guardCalls = 0;
    const acceptingDeliveries = Object.getOwnPropertyDescriptor(
      RuntimeCrashRecoveryCoordinator.prototype,
      "acceptingDeliveries",
    )!.get!;
    f.onResetRefusal(() => {
      // Fault injection starts only after SQLite actually refuses the reset.
      // The real coordinator and physical terminal writes are otherwise unchanged.
      Object.defineProperty(f.recovery, "acceptingDeliveries", {
        configurable: true,
        get() {
          guardCalls++;
          if (guardCalls === 1) throw new Error("fixture secondary projection guard failure");
          return acceptingDeliveries.call(f.recovery);
        },
      });
      cleanups.push(() => {
        Reflect.deleteProperty(f.recovery, "acceptingDeliveries");
      });
    });
    await expect(f.run()).rejects.toThrow(RESET_ERROR);
    expect(guardCalls).toBeGreaterThan(0);
    expect(dbGetChannelBackendRuntimeState(f.metadata.binding.turnId)).toEqual(f.logicalBefore);
    expect(f.events).toEqual([]);
    expect(f.outputs).toEqual([]);
    expectPhysicalFailureOnce(f);
    expectNoRecovery(f);
  });

  it("keeps the logical request open when reset succeeds, with one recovery and unchanged physical accounting", async () => {
    const f = await fixture({ rejectReset: false });
    const successor = createQueuedRuntimeUserMessage({
      prompt: "Independent successor",
      deliveryBarrier: "after_response",
    });
    f.streaming.pendingMessages.push(successor);
    await f.run();
    expect(f.resetRefusals()).toBe(0);
    expectPhysicalFailureOnce(f);
    expect(dbGetChannelBackendRuntimeState(f.metadata.binding.turnId)).toEqual(f.logicalBefore);
    expect(f.events).toEqual([]);
    expect(f.outputs).toEqual([]);
    expect(f.restarts).toEqual([{ sessionName: f.session.name!, reason: "runtime_context_window_exhausted" }]);
    expect(f.stash.get(f.session.name!)).toHaveLength(2);
    expect(f.stash.get(f.session.name!)?.[0]?.message.content).toContain("Fixture request a");
    expect(f.stash.get(f.session.name!)?.[1]).toEqual(successor);
    expect(resolveSession(f.session.sessionKey)?.providerSessionId).toBeUndefined();
  });

  for (const witness of ["slot", "lease", "binding", "handle"] as const) {
    it(`refuses logical writes when the ${witness} is lost after reset refusal but before projection`, async () => {
      const f = await fixture({ initiallyRunning: false });
      const successorMetadata = await acceptedMetadata("b");
      const successorLogical = dbGetChannelBackendRuntimeState(successorMetadata.binding.turnId);
      const successorQueue = [
        createQueuedRuntimeUserMessage({ prompt: "Successor-owned queue", _channelBackend: successorMetadata }),
      ];
      const successor = successorSession(successorMetadata, successorQueue);
      let refusalHooks = 0;
      f.onResetRefusal(() => {
        refusalHooks++;
        // This hook runs only after the real SQLite trigger has refused RESET.
        if (witness === "slot") {
          f.live.set(f.session.name!, successor);
          f.stash.set(f.session.name!, successorQueue);
        } else if (witness === "lease") f.expireLease();
        else if (witness === "binding") f.streaming.currentChannelBackend = successorMetadata;
        else f.streaming.queryHandle = successor.queryHandle;
      });
      await expect(f.run()).rejects.toThrow(RESET_ERROR);
      expect(refusalHooks).toBe(1);
      expect(f.resetRefusals()).toBe(1);
      expect(dbGetChannelBackendRuntimeState(f.metadata.binding.turnId)).toEqual(f.logicalBefore);
      expect(dbGetChannelBackendRuntimeState(successorMetadata.binding.turnId)).toEqual(successorLogical);
      expect(f.events).toEqual([]);
      expect(f.outputs).toEqual([]);
      expect(f.restarts).toEqual([]);
      expect(successor.pendingMessages).toBe(successorQueue);
      expect(successor.currentChannelBackend).toBe(successorMetadata);
      expect(successor.done).toBe(false);
      expect(successor.abortController.signal.aborted).toBe(false);
      if (witness === "slot") {
        expect(f.live.get(f.session.name!)).toBe(successor);
        expect(f.stash.get(f.session.name!)).toBe(successorQueue);
      } else {
        expectNoRecovery(f);
      }
      expectPhysicalFailureOnce(f);
      expect(resolveSession(f.session.sessionKey)?.providerSessionId).toBe("fixture-native-session");
    });
  }

  it("settles before the first running sink replaces the owner and leaves successor state untouched", async () => {
    const f = await fixture({ initiallyRunning: false });
    const successorMetadata = await acceptedMetadata("b");
    const successorLogical = dbGetChannelBackendRuntimeState(successorMetadata.binding.turnId);
    const successorQueue = [
      createQueuedRuntimeUserMessage({ prompt: "Successor-owned queue", _channelBackend: successorMetadata }),
    ];
    const successor = successorSession(successorMetadata, successorQueue);
    let runningSinkCalls = 0;
    let logicalStateAtSink: string | undefined;
    let physicalStateAtSink: string | undefined;
    f.onRuntimeSink(async (event) => {
      if (event.kind !== "turn.state_changed") return;
      runningSinkCalls++;
      logicalStateAtSink = dbGetChannelBackendRuntimeState(f.metadata.binding.turnId)?.state;
      physicalStateAtSink = getRuntimeTurnAttempt(f.attempt.attemptId)?.status;
      await Promise.resolve();
      f.live.set(f.session.name!, successor);
      f.stash.set(f.session.name!, successorQueue);
      // Assert the pre-fault snapshot only after applying the fault, so the
      // baseline still exercises owner loss instead of aborting this hook early.
      expect(logicalStateAtSink).toBe("failed");
      expect(physicalStateAtSink).toBe("failed");
    });
    await expect(f.run()).rejects.toThrow(RESET_ERROR);
    expect(runningSinkCalls).toBe(1);
    expect(logicalStateAtSink).toBe("failed");
    expect(physicalStateAtSink).toBe("failed");
    expect(f.live.get(f.session.name!)).toBe(successor);
    expect(f.stash.get(f.session.name!)).toBe(successorQueue);
    expect(successor.pendingMessages).toBe(successorQueue);
    expect(successor.abortController.signal.aborted).toBe(false);
    expect(successor.done).toBe(false);
    expect(dbGetChannelBackendRuntimeState(successorMetadata.binding.turnId)).toEqual(successorLogical);
    expectLogicalFailureOnce(f);
    expect(f.events.map((event) => event.kind)).toEqual(["turn.state_changed", "turn.terminal_output"]);
    expect(f.resetRefusals()).toBe(1);
    expect(f.restarts).toEqual([]);
    expectPhysicalFailureOnce(f);
    expect(resolveSession(f.session.sessionKey)?.providerSessionId).toBe("fixture-native-session");
  });

  for (const witness of ["lease", "binding", "handle"] as const) {
    it(`settles before the first running sink loses the captured ${witness}`, async () => {
      const f = await fixture({ initiallyRunning: false });
      const successorMetadata = await acceptedMetadata("b");
      const successorLogical = dbGetChannelBackendRuntimeState(successorMetadata.binding.turnId);
      let runningSinkCalls = 0;
      let logicalStateAtSink: string | undefined;
      let physicalStateAtSink: string | undefined;
      f.onRuntimeSink(async (event) => {
        if (event.kind !== "turn.state_changed") return;
        runningSinkCalls++;
        logicalStateAtSink = dbGetChannelBackendRuntimeState(f.metadata.binding.turnId)?.state;
        physicalStateAtSink = getRuntimeTurnAttempt(f.attempt.attemptId)?.status;
        await Promise.resolve();
        if (witness === "lease") f.expireLease();
        else if (witness === "binding") f.streaming.currentChannelBackend = successorMetadata;
        else f.streaming.queryHandle = { ...f.runtime };
        expect(logicalStateAtSink).toBe("failed");
        expect(physicalStateAtSink).toBe("failed");
      });
      await expect(f.run()).rejects.toThrow(RESET_ERROR);
      expect(runningSinkCalls).toBe(1);
      expect(logicalStateAtSink).toBe("failed");
      expect(physicalStateAtSink).toBe("failed");
      expectLogicalFailureOnce(f);
      expect(dbGetChannelBackendRuntimeState(successorMetadata.binding.turnId)).toEqual(successorLogical);
      expect(f.events.map((event) => event.kind)).toEqual(["turn.state_changed", "turn.terminal_output"]);
      expectPhysicalFailureOnce(f);
      expectNoRecovery(f);
    });
  }

  it("settles before real dispatcher retirement and admits an independent successor once", async () => {
    const f = await fixture({ initiallyRunning: false, realDispatcher: true });
    const dispatcher = f.dispatcher;
    if (!dispatcher) throw new Error("Real dispatcher fixture was not initialized");
    const successorMetadata = await acceptedMetadata("b");
    const successorLogical = dbGetChannelBackendRuntimeState(successorMetadata.binding.turnId);
    const successorQueue: RuntimeUserMessage[] = [];
    const successor = successorSession(successorMetadata, successorQueue);
    const started: Array<{ name: string; prompt: RuntimeLaunchPrompt }> = [];
    const historyBefore = getRecentHistory(f.session.name!);
    let runningSinkCalls = 0;
    let logicalStateAtSink: string | undefined;
    let physicalAtSink: ReturnType<typeof getRuntimeTurnAttempt> | undefined;
    let retirementCompleted = false;
    let retiredAtLaunch:
      | { done: boolean; aborted: boolean; owner: RuntimeHostStreamingSession | undefined }
      | undefined;
    let stashAtLaunch: RuntimeUserMessage[] | undefined;
    let retainedPendingIds: Array<string | undefined> = [];
    const interrupt = spyOn(f.runtime, "interrupt");
    const successorInterrupt = spyOn(successor.queryHandle, "interrupt");
    // Only the external-launch boundary is replaced. Provider selection,
    // retirement, physical fences, slot release and admission run for real.
    // This does not claim a provider start or successor history persistence.
    const launch = spyOn(dispatcher, "startStreamingSession").mockImplementation(async (name, prompt) => {
      started.push({ name, prompt });
      retiredAtLaunch = {
        done: f.streaming.done,
        aborted: f.streaming.abortController.signal.aborted,
        owner: f.live.get(name),
      };
      stashAtLaunch = f.stash.get(name);
      retainedPendingIds = (stashAtLaunch ?? []).map((message) => message.pendingId);
      successorQueue.push(createQueuedRuntimeUserMessage(prompt));
      successor.currentTurnPendingIds = successorQueue.map((message) => message.pendingId!);
      f.live.set(name, successor);
    });
    cleanups.push(
      () => interrupt.mockRestore(),
      () => successorInterrupt.mockRestore(),
      () => launch.mockRestore(),
    );
    configStore.refresh();
    f.onRuntimeSink(async (event) => {
      if (event.kind !== "turn.state_changed") return;
      runningSinkCalls++;
      logicalStateAtSink = dbGetChannelBackendRuntimeState(f.metadata.binding.turnId)?.state;
      physicalAtSink = getRuntimeTurnAttempt(f.attempt.attemptId);
      updateSessionRuntimeProviderOverride(f.session.sessionKey, "codex");
      await dispatcher.handlePromptImmediate(f.session.name!, {
        prompt: "Independent successor B",
        _agentId: successorMetadata.binding.agentId,
        _channelBackend: successorMetadata,
        source: successor.currentSource,
        deliveryBarrier: "after_tool",
      });
      retirementCompleted = true;
      // Capture before retirement, assert after it: a RED baseline still runs
      // the real handoff instead of throwing out of the hook before the fault.
      expect(logicalStateAtSink).toBe("failed");
      expect(physicalAtSink?.status).toBe("failed");
    });
    await expect(f.run()).rejects.toThrow(RESET_ERROR);
    expect(runningSinkCalls).toBe(1);
    expect(retirementCompleted).toBe(true);
    expect(logicalStateAtSink).toBe("failed");
    expect(physicalAtSink?.status).toBe("failed");
    expect(getRuntimeTurnAttempt(f.attempt.attemptId)).toEqual(physicalAtSink!);
    expect(retiredAtLaunch).toEqual({ done: true, aborted: true, owner: undefined });
    expect(interrupt).toHaveBeenCalled();
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      name: f.session.name!,
      prompt: { _agentId: successorMetadata.binding.agentId, _channelBackend: successorMetadata },
    });
    expect(started[0]?.prompt.prompt).toContain("Independent successor B");
    expect(started[0]?.prompt._resumeStashedMessages).not.toBe(true);
    expect(f.live.get(f.session.name!)).toBe(successor);
    expect(successor.currentChannelBackend).toBe(successorMetadata);
    expect(successor.currentSource?.sourceMessageId).toBe(successorMetadata.binding.messageId);
    expect(successor.pendingMessages).toBe(successorQueue);
    expect(successorQueue).toHaveLength(1);
    expect(successorQueue[0]?.launchPrompt?._channelBackend).toEqual(successorMetadata);
    expect(successor.currentTurnPendingIds).toEqual([successorQueue[0]!.pendingId!]);
    expect(successor.currentTraceTurnId).toBeUndefined();
    expect(successor.currentCrashRecoveryAttemptId).toBeUndefined();
    expect(successor.currentCrashRecoveryTerminal).toBeUndefined();
    expect(successor.traceRunId).not.toBe(f.streaming.traceRunId);
    expect(successor.done).toBe(false);
    expect(successor.abortController.signal.aborted).toBe(false);
    expect(successorInterrupt).not.toHaveBeenCalled();
    expect(dbGetChannelBackendRuntimeState(successorMetadata.binding.turnId)).toEqual(successorLogical);
    // The synthetic failed provider has not driven the real prompt generator's
    // queue drain. Preserve its retained A atom; do not manufacture an empty
    // stash or claim this boundary covers real provider replay/consumption.
    expect(f.stash.get(f.session.name!)).toBe(stashAtLaunch);
    expect((f.stash.get(f.session.name!) ?? []).map((message) => message.pendingId)).toEqual(retainedPendingIds);
    const admittedPendingIds = [...retainedPendingIds, ...successorQueue.map((message) => message.pendingId)];
    expect(admittedPendingIds.every((pendingId) => typeof pendingId === "string")).toBe(true);
    expect(new Set(admittedPendingIds).size).toBe(admittedPendingIds.length);
    expect(
      (f.stash.get(f.session.name!) ?? []).filter(
        (message) => message.launchPrompt?._channelBackend?.binding.turnId === successorMetadata.binding.turnId,
      ),
    ).toHaveLength(0);
    expect(getRecentHistory(f.session.name!)).toEqual(historyBefore);
    const retirements = querySessionTrace({
      sessionKey: f.session.sessionKey,
      sessionName: f.session.name!,
    }).events.filter((event) => event.eventType === "dispatch.restart_requested");
    expect(retirements).toHaveLength(1);
    expect(retirements[0]?.payloadJson).toMatchObject({
      reason: "provider_change",
      activeProvider: f.runtime.provider,
      requestedProvider: "codex",
    });
    expectLogicalFailureOnce(f);
    expect(f.events.map((event) => event.kind)).toEqual(["turn.state_changed", "turn.terminal_output"]);
    expectPhysicalFailureOnce(f);
    expect(f.resetRefusals()).toBe(1);
    expect(f.restarts).toEqual([]);
    expect(resolveSession(f.session.sessionKey)).toMatchObject({
      runtimeProviderOverride: "codex",
      providerSessionId: "fixture-native-session",
    });
  });

  for (const loseLease of [false, true]) {
    it(`records retired failure usage without reviving terminal notification after lease loss (lost=${loseLease})`, async () => {
      const f = await fixture({ initiallyRunning: false, realDispatcher: true });
      let retirements = 0;
      let physicalAtSink: ReturnType<typeof getRuntimeTurnAttempt> | undefined;
      f.onRuntimeSink(async (event) => {
        if (event.kind !== "turn.state_changed") return;
        physicalAtSink = getRuntimeTurnAttempt(f.attempt.attemptId);
        expect(physicalAtSink?.status).toBe("failed");
        expect(dbGetChannelBackendRuntimeState(f.metadata.binding.turnId)?.state).toBe("failed");
        expect(
          await f.dispatcher!.applySessionModelChange(f.session.name!, "fixture-next-model", {
            drainReleasedSlot: false,
            restartStashedMessages: false,
          }),
        ).toBe("restart-next-turn");
        retirements++;
        expect(f.streaming.done).toBe(true);
        expect(f.live.has(f.session.name!)).toBe(false);
        if (loseLease) {
          f.expireLease();
          expect(() => f.recovery.heartbeatNow()).toThrow();
          expect(f.recovery.ownershipFailure).not.toBeNull();
          expect(f.recovery.acceptingDeliveries).toBe(false);
        }
      });
      await expect(f.run()).rejects.toThrow(RESET_ERROR);
      expect(retirements).toBe(1);
      expectPhysicalFailureOnce(f);
      expect(getRuntimeTurnAttempt(f.attempt.attemptId)).toEqual(physicalAtSink!);
      expectLogicalFailureOnce(f);
      expect(f.resetRefusals()).toBe(1);
      expect(f.restarts).toEqual([]);
      expect(
        f.hostEmits.filter(
          ({ data }) =>
            data.type === "turn.failed" || data.type === "turn.interrupted" || data.type === "turn.complete",
        ),
      ).toHaveLength(loseLease ? 0 : 1);
      expect(f.hostEmits.filter(({ data }) => data.type === "provider.raw")).toEqual([]);
      expect(
        listSessionEventsByTurn(f.trace.turnId).filter((event) => event.eventType === "session.unterminated_turn"),
      ).toHaveLength(loseLease ? 0 : 1);
      expect(f.streaming.currentCrashRecoveryAttemptId).toBeUndefined();
      expect(f.live.has(f.session.name!)).toBe(false);
    });
  }

  it("does not restart recovery when an explicit cancellation arrives at the running sink", async () => {
    const f = await fixture({ initiallyRunning: false });
    let runningSinkCalls = 0;
    let logicalStateAtSink: string | undefined;
    f.onRuntimeSink(async (event) => {
      if (event.kind !== "turn.state_changed") return;
      runningSinkCalls++;
      logicalStateAtSink = dbGetChannelBackendRuntimeState(f.metadata.binding.turnId)?.state;
      await Promise.resolve();
      const terminal = f.streaming.currentCrashRecoveryTerminal;
      f.streaming.pendingAbort = true;
      f.streaming.internalAbortReason = "explicit_abort";
      f.streaming.abortController.abort();
      expect(f.live.get(f.session.name!)).toBe(f.streaming);
      expect(f.streaming.queryHandle).toBe(f.runtime);
      expect(f.streaming.currentCrashRecoveryTerminal).toBe(terminal);
      expect(terminal?.status).toBe("failed");
      expect(logicalStateAtSink).toBe("failed");
    });
    await expect(f.run()).rejects.toThrow(RESET_ERROR);
    expect(runningSinkCalls).toBe(1);
    expect(logicalStateAtSink).toBe("failed");
    expectLogicalFailureOnce(f);
    expectPhysicalFailureOnce(f);
    expect(f.resetRefusals()).toBe(1);
    expect(f.restarts).toEqual([]);
    expect(f.streaming.done).toBe(true);
  });

  it("does not overwrite provider configuration changed at the running sink", async () => {
    const f = await fixture({ initiallyRunning: false });
    let configured: Record<string, unknown> | undefined;
    let runningSinkCalls = 0;
    let logicalStateAtSink: string | undefined;
    f.onRuntimeSink(async (event) => {
      if (event.kind !== "turn.state_changed") return;
      runningSinkCalls++;
      logicalStateAtSink = dbGetChannelBackendRuntimeState(f.metadata.binding.turnId)?.state;
      await Promise.resolve();
      const terminal = f.streaming.currentCrashRecoveryTerminal;
      const traceTurnId = f.streaming.currentTraceTurnId;
      updateSessionRuntimeProviderOverride(f.session.sessionKey, "codex");
      expect(f.live.get(f.session.name!)).toBe(f.streaming);
      expect(f.streaming.queryHandle).toBe(f.runtime);
      expect(f.streaming.currentTraceTurnId).toBe(traceTurnId);
      expect(f.streaming.currentCrashRecoveryTerminal).toBe(terminal);
      const changed = resolveSession(f.session.sessionKey)!;
      configured = { runtimeProviderOverride: "codex" };
      // The 797 lineage also persists a revision; 795 has only the override.
      if ("runtimeProviderConfigRevision" in changed) {
        expect(changed.runtimeProviderConfigRevision).toBe(1);
        configured.runtimeProviderConfigRevision = changed.runtimeProviderConfigRevision;
      }
      expect(changed).toMatchObject(configured);
      expect(logicalStateAtSink).toBe("failed");
    });
    await expect(f.run()).rejects.toThrow(RESET_ERROR);
    expect(runningSinkCalls).toBe(1);
    expect(logicalStateAtSink).toBe("failed");
    expectLogicalFailureOnce(f);
    expectPhysicalFailureOnce(f);
    expectNoRecovery(f);
    expect(configured).toBeDefined();
    expect(resolveSession(f.session.sessionKey)).toMatchObject(configured!);
  });
});

const runtimeCapabilities: RuntimeCapabilities = {
  runtimeControl: { supported: false, operations: [] },
  dynamicTools: { mode: "none" },
  execution: { mode: "sdk" },
  sessionState: { mode: "provider-session-id" },
  usage: { semantics: "terminal-event" },
  tools: { permissionMode: "ravi-host", accessRequirement: "tool_and_executable", supportsParallelCalls: false },
  systemPrompt: { mode: "append" },
  terminalEvents: { guarantee: "adapter" },
  skillVisibility: { availability: "none", loadedState: "none" },
  supportsSessionResume: false,
  supportsSessionFork: false,
  supportsPartialText: true,
  supportsToolHooks: false,
  supportsHostSessionHooks: false,
  supportsPlugins: false,
  supportsMcpServers: false,
  supportsRemoteSpawn: false,
};
