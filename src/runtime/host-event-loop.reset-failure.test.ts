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
import * as pricing from "../costs/pricing-catalog.js";
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
import { recordAdapterRequestTrace } from "../session-trace/runtime-trace.js";
import { getSessionTurn, listSessionEventsByTurn } from "../session-trace/session-trace-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { RuntimeCrashRecoveryCoordinator } from "./crash-recovery.js";
import { getRuntimeTurnAttempt } from "./crash-recovery-store.js";
import { createQueuedRuntimeUserMessage } from "./delivery-queue.js";
import { runRuntimeEventLoop } from "./host-event-loop.js";
import type { RuntimeHostStreamingSession, RuntimeUserMessage } from "./host-session.js";
import type { ChannelBackendPromptMetadata } from "./message-types.js";
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
async function fixture(options: { rejectReset?: boolean; initiallyRunning?: boolean } = {}) {
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
  const live = new Map([[session.name!, streaming]]);
  const stash = new Map<string, RuntimeUserMessage[]>();
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
    outputs,
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
        safeEmit: async () => {},
        drainPendingStarts: () => {},
        crashRecovery: recovery,
        restartStashedSession: async (input) => {
          restarts.push(input);
        },
      }),
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

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

  it("rechecks the owner after awaiting the running sink and leaves successor state untouched", async () => {
    const f = await fixture({ initiallyRunning: false });
    const successorMetadata = await acceptedMetadata("b");
    const successorLogical = dbGetChannelBackendRuntimeState(successorMetadata.binding.turnId);
    const successorQueue = [createQueuedRuntimeUserMessage({ prompt: "Successor-owned queue" })];
    const successor: RuntimeHostStreamingSession = {
      ...f.streaming,
      queryHandle: { ...f.runtime },
      abortController: new AbortController(),
      currentChannelBackend: successorMetadata,
      pendingMessages: successorQueue,
      currentTurnPendingIds: [successorQueue[0]!.pendingId!],
      currentTraceTurnId: undefined,
      currentCrashRecoveryAttemptId: undefined,
      currentCrashRecoveryTerminal: undefined,
    };
    f.onRuntimeSink(async (event) => {
      if (event.kind !== "turn.state_changed") return;
      expect(getRuntimeTurnAttempt(f.attempt.attemptId)?.status).toBe("failed");
      await Promise.resolve();
      f.live.set(f.session.name!, successor);
      f.stash.set(f.session.name!, successorQueue);
    });
    await expect(f.run()).rejects.toThrow(RESET_ERROR);
    expect(f.live.get(f.session.name!)).toBe(successor);
    expect(f.stash.get(f.session.name!)).toBe(successorQueue);
    expect(successor.pendingMessages).toBe(successorQueue);
    expect(successor.abortController.signal.aborted).toBe(false);
    expect(successor.done).toBe(false);
    expect(dbGetChannelBackendRuntimeState(successorMetadata.binding.turnId)).toEqual(successorLogical);
    expect(dbGetChannelBackendRuntimeState(f.metadata.binding.turnId)?.state).toBe("running");
    expect(f.events.map((event) => event.kind)).toEqual(["turn.state_changed"]);
    expect(f.outputs).toEqual([]);
    expect(f.restarts).toEqual([]);
    expectPhysicalFailureOnce(f);
  });

  for (const witness of ["lease", "binding", "handle"] as const) {
    it(`rechecks the captured ${witness} after awaiting the running sink`, async () => {
      const f = await fixture({ initiallyRunning: false });
      const successorMetadata = await acceptedMetadata("b");
      const successorLogical = dbGetChannelBackendRuntimeState(successorMetadata.binding.turnId);
      f.onRuntimeSink(async (event) => {
        if (event.kind !== "turn.state_changed") return;
        await Promise.resolve();
        if (witness === "lease") f.expireLease();
        else if (witness === "binding") f.streaming.currentChannelBackend = successorMetadata;
        else f.streaming.queryHandle = { ...f.runtime };
      });
      await expect(f.run()).rejects.toThrow(RESET_ERROR);
      expect(dbGetChannelBackendRuntimeState(f.metadata.binding.turnId)?.state).toBe("running");
      expect(dbGetChannelBackendRuntimeState(successorMetadata.binding.turnId)).toEqual(successorLogical);
      expect(f.events.map((event) => event.kind)).toEqual(["turn.state_changed"]);
      expect(f.outputs).toEqual([]);
      expectPhysicalFailureOnce(f);
      expectNoRecovery(f);
    });
  }

  it("does not restart recovery when an explicit cancellation arrives at the running sink", async () => {
    const f = await fixture({ initiallyRunning: false });
    f.onRuntimeSink(async (event) => {
      if (event.kind !== "turn.state_changed") return;
      await Promise.resolve();
      const terminal = f.streaming.currentCrashRecoveryTerminal;
      f.streaming.pendingAbort = true;
      f.streaming.internalAbortReason = "explicit_abort";
      f.streaming.abortController.abort();
      expect(f.live.get(f.session.name!)).toBe(f.streaming);
      expect(f.streaming.queryHandle).toBe(f.runtime);
      expect(f.streaming.currentCrashRecoveryTerminal).toBe(terminal);
      expect(terminal?.status).toBe("failed");
    });
    await expect(f.run()).rejects.toThrow(RESET_ERROR);
    expectLogicalFailureOnce(f);
    expectPhysicalFailureOnce(f);
    expect(f.restarts).toEqual([]);
    expect(f.streaming.done).toBe(true);
  });

  it("does not overwrite provider configuration changed at the running sink", async () => {
    const f = await fixture({ initiallyRunning: false });
    let configured: Record<string, unknown> | undefined;
    f.onRuntimeSink(async (event) => {
      if (event.kind !== "turn.state_changed") return;
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
    });
    await expect(f.run()).rejects.toThrow(RESET_ERROR);
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
