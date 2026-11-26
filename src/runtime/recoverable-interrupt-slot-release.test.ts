import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as pricing from "../costs/pricing-catalog.js";
import { nats } from "../nats.js";
import { dbCreateAgent, dbGetAgent, getDb } from "../router/router-db.js";
import { getOrCreateSession, resolveSession } from "../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import type { RuntimeCrashRecoveryCoordinator } from "./crash-recovery.js";
import { createQueuedRuntimeUserMessage, createRuntimeMessageGenerator } from "./delivery-queue.js";
import { runRuntimeEventLoop } from "./host-event-loop.js";
import { isReleasableDoneRuntimeSession, type RuntimeHostStreamingSession } from "./host-session.js";
import { RuntimeSessionDispatcher } from "./session-dispatcher.js";
import type { RuntimeCapabilities, RuntimeEvent, RuntimeSessionHandle } from "./types.js";

/**
 * 25/11 incident (session `main`): a reply interrupted the running turn, the
 * provider answered `error_during_execution`, and the host suppressed it as a
 * recoverable interrupt and stashed the queued reply for a restart. While the
 * provider was still closing, the pool reclaimer's 60 s tick released the
 * slot of the already-`done` session. The event loop then found the slot gone,
 * skipped the restart, and the reply sat in the stash for 19 minutes.
 */

let stateDir: string | null = null;
const cleanups: Array<() => void> = [];

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-recoverable-interrupt-slot-");
  dbCreateAgent({ id: "agent-a", name: "Agent A", cwd: stateDir });
  const emit = spyOn(nats, "emit").mockImplementation(async () => {});
  const prewarm = spyOn(pricing, "prewarmPricingCatalog").mockImplementation(() => {});
  cleanups.push(
    () => emit.mockRestore(),
    () => prewarm.mockRestore(),
  );
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

const capabilities: RuntimeCapabilities = {
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

/** The provider's answer to the interrupt, as logged on 25/11 at 13:18:11. */
const interruptedDuringExecution: RuntimeEvent = {
  type: "turn.failed",
  error: "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null",
  recoverable: true,
  rawEvent: { type: "result", subtype: "error_during_execution" },
};

const crashRecoveryStub = { acceptingDeliveries: true } as unknown as RuntimeCrashRecoveryCoordinator;

function newDispatcher(options: { turnInactivityMs?: number } = {}) {
  return new RuntimeSessionDispatcher({
    instanceId: "slot-release-test",
    maxConcurrentSessions: 4,
    interactiveReservedSessions: 0,
    safeEmit: async () => {},
    notifyRuntimeRecoveryExhausted: async () => {},
    getConfigModel: () => "test-model",
    crashRecovery: crashRecoveryStub,
    ...options,
  });
}

async function fixture() {
  const sessionKey = "agent:agent-a:slack:local:dm:D123";
  getOrCreateSession(sessionKey, "agent-a", stateDir!, {
    name: "dm-session",
    channel: "slack",
    accountId: "local",
    chatType: "dm",
    lastChannel: "slack",
    lastAccountId: "local",
    lastTo: "D123",
  });
  const session = resolveSession(sessionKey)!;
  const agent = dbGetAgent("agent-a")!;
  const source = { channel: "slack", accountId: "local", instanceId: "local", chatId: "D123" };
  const dispatcher = newDispatcher();
  const streaming: RuntimeHostStreamingSession = {
    sessionKey,
    agentId: "agent-a",
    queryHandle: { provider: "claude", events: (async function* () {})(), async interrupt() {} },
    starting: false,
    abortController: new AbortController(),
    pushMessage: null,
    pendingWake: false,
    pendingMessages: [
      createQueuedRuntimeUserMessage({
        prompt: "da pra testar o terraform numa vm?",
        source,
        _agentId: "agent-a",
        deliveryBarrier: "after_tool",
      }),
    ],
    currentSource: source,
    currentModel: "test-model",
    toolRunning: false,
    lastActivity: Date.now(),
    done: false,
    interrupted: false,
    turnActive: false,
    compacting: false,
    onTurnComplete: null,
    currentToolSafety: null,
    pendingAbort: false,
    agentMode: "active",
    // claude + ravi-host permissions, as resolveRuntimeToolEffectFence gives in production.
    toolEffectFence: "host_write_ahead",
  };
  dispatcher.streamingSessions.set(session.name!, streaming);

  // Yield the first prompt as the running turn, the way the launcher does.
  const generator = createRuntimeMessageGenerator({
    sessionName: session.name!,
    session: streaming,
    stashedMessages: dispatcher.stashedMessages,
  });
  expect((await generator.next()).done).toBe(false);
  cleanups.push(() => void generator.return(undefined));

  // A reply arrives and interrupts the running turn (dispatcher push + interrupt).
  const reply = createQueuedRuntimeUserMessage({
    prompt: "sabe qual ambiente estavamos rodando esses testes?",
    source,
    _agentId: "agent-a",
    deliveryBarrier: "after_tool",
  });
  streaming.pendingMessages.push(reply);
  streaming.currentTurnSuperseded = true;
  streaming.interrupted = true;

  const restarts: Array<{ sessionName: string; reason: string }> = [];
  const run = async (onProviderClose: () => void) => {
    const runtimeSession: RuntimeSessionHandle = {
      provider: "claude",
      events: (async function* () {
        yield interruptedDuringExecution;
      })(),
      async interrupt() {},
      // Closing claude-code takes seconds; the pool reclaimer can tick here.
      async close() {
        onProviderClose();
      },
    };
    streaming.queryHandle = runtimeSession;
    await runRuntimeEventLoop({
      runId: "run-slot-release",
      sessionName: session.name!,
      session,
      agent,
      streaming,
      runtimeSession,
      runtimeCapabilities: capabilities,
      model: "test-model",
      instanceId: "slot-release-test",
      defaultRuntimeProviderId: "claude",
      streamingSessions: dispatcher.streamingSessions,
      stashedMessages: dispatcher.stashedMessages,
      safeEmit: async () => {},
      restartStashedSession: async (input) => {
        restarts.push(input);
      },
      drainPendingStarts() {},
    });
  };
  return { session, streaming, dispatcher, reply, restarts, run, running: streaming.pendingMessages[0]! };
}

function skippedRestarts(sessionKey: string): Array<Record<string, unknown>> {
  return (
    getDb()
      .prepare(
        "SELECT payload_json FROM session_events WHERE session_key = ? AND event_type = 'dispatch.restart_skipped'",
      )
      .all(sessionKey) as Array<{ payload_json: string }>
  ).map((row) => JSON.parse(row.payload_json) as Record<string, unknown>);
}

describe("recoverable interrupt keeps its runtime slot until cleanup restarts the stash", () => {
  it("restarts the stashed reply when the pool reclaimer ticks while the provider is closing", async () => {
    const f = await fixture();
    let sweptWhileClosing = false;

    await f.run(() => {
      sweptWhileClosing = f.streaming.done && f.dispatcher.streamingSessions.get(f.session.name!) === f.streaming;
      f.dispatcher.reclaimNonServingRuntimeSessions();
    });

    // The race really happened: the sweep ran on the finished, still-closing session.
    expect(sweptWhileClosing).toBe(true);
    expect(f.restarts).toEqual([{ sessionName: f.session.name!, reason: "recoverable_interrupt_failure" }]);
    const stashed = f.dispatcher.stashedMessages.get(f.session.name!) ?? [];
    expect(stashed.map((message) => message.pendingId)).toContain(f.reply.pendingId);
    expect(skippedRestarts(f.session.sessionKey)).toEqual([]);
    expect(f.dispatcher.streamingSessions.has(f.session.name!)).toBe(false);
    expect(f.streaming.eventLoopActive).toBe(false);
  });

  it("records a visible skipped restart when another owner takes the slot during cleanup", async () => {
    const f = await fixture();

    // Any other path that frees the slot mid-cleanup (here: removed outright).
    await f.run(() => {
      f.dispatcher.streamingSessions.delete(f.session.name!);
    });

    expect(f.restarts).toEqual([]);
    const stashed = f.dispatcher.stashedMessages.get(f.session.name!) ?? [];
    expect(stashed.map((message) => message.pendingId)).toContain(f.reply.pendingId);
    expect(skippedRestarts(f.session.sessionKey)).toEqual([
      {
        reason: "recoverable_interrupt_failure",
        skippedReason: "runtime_slot_released",
        stashedQueueSize: stashed.length,
        replacementOwnsSlot: false,
      },
    ]);
  });
});

describe("pool reclaimer and finished sessions", () => {
  function finishedSession(overrides: {
    eventLoopActive?: boolean;
    lastActivity?: number;
    closingObservedAt?: number;
  }): RuntimeHostStreamingSession {
    const session: RuntimeHostStreamingSession = {
      sessionKey: "agent:agent-a:main",
      agentId: "agent-a",
      currentModel: "test-model",
      queryHandle: { provider: "claude", events: (async function* () {})(), async interrupt() {} },
      starting: false,
      abortController: new AbortController(),
      pushMessage: null,
      pendingWake: false,
      pendingMessages: [],
      toolRunning: false,
      lastActivity: Date.now(),
      done: true,
      interrupted: false,
      turnActive: false,
      compacting: false,
      onTurnComplete: null,
      currentToolSafety: null,
      pendingAbort: false,
      agentMode: "active",
    };
    if (overrides.eventLoopActive !== undefined) session.eventLoopActive = overrides.eventLoopActive;
    if (overrides.lastActivity !== undefined) session.lastActivity = overrides.lastActivity;
    if (overrides.closingObservedAt !== undefined) session.closingObservedAt = overrides.closingObservedAt;
    return session;
  }

  it("leaves a finished session to its running event loop", () => {
    const dispatcher = newDispatcher();
    const now = Date.now();
    dispatcher.streamingSessions.set("closing", finishedSession({ eventLoopActive: true, lastActivity: now - 6_000 }));

    dispatcher.reclaimNonServingRuntimeSessions(now);

    expect(dispatcher.streamingSessions.has("closing")).toBe(true);
  });

  it("still releases a finished session whose event loop exited or stopped making progress", () => {
    const dispatcher = newDispatcher({ turnInactivityMs: 60_000 });
    const now = Date.now();
    dispatcher.streamingSessions.set("exited", finishedSession({ eventLoopActive: false }));
    dispatcher.streamingSessions.set("legacy", finishedSession({}));
    dispatcher.streamingSessions.set(
      "wedged",
      finishedSession({ eventLoopActive: true, closingObservedAt: now - 61_000 }),
    );
    // A turn that was silent for long before it ended is still closing, not wedged.
    dispatcher.streamingSessions.set(
      "silent-then-closing",
      finishedSession({ eventLoopActive: true, lastActivity: now - 3_600_000 }),
    );

    dispatcher.reclaimNonServingRuntimeSessions(now);

    expect([...dispatcher.streamingSessions.keys()]).toEqual(["silent-then-closing"]);
  });

  it("applies the same rule to observer sessions in the same tick", () => {
    const dispatcher = newDispatcher({ turnInactivityMs: 60_000 });
    const now = Date.now();
    dispatcher.streamingSessions.set("obs:closing", finishedSession({ eventLoopActive: true }));
    dispatcher.streamingSessions.set(
      "obs:wedged",
      finishedSession({ eventLoopActive: true, closingObservedAt: now - 61_000 }),
    );
    // A live idle observer keeps its loop running for its whole life and stays reclaimable.
    const idle = finishedSession({ eventLoopActive: true });
    idle.done = false;
    dispatcher.streamingSessions.set("obs:idle", idle);

    dispatcher.reclaimNonServingRuntimeSessions(now);

    expect([...dispatcher.streamingSessions.keys()]).toEqual(["obs:closing"]);
  });

  it("treats a finished session as releasable only once its event loop has exited", () => {
    expect(isReleasableDoneRuntimeSession({ done: true, eventLoopActive: true })).toBe(false);
    expect(isReleasableDoneRuntimeSession({ done: true, eventLoopActive: false })).toBe(true);
    expect(isReleasableDoneRuntimeSession({ done: true })).toBe(true);
    expect(isReleasableDoneRuntimeSession({ done: false, eventLoopActive: false })).toBe(false);
  });

  it("re-delivers the superseded turn's own message when it was stopped before the provider checked it", async () => {
    // 26/11 19:58Z: the interrupted turn's prompt never reached the provider (prompt_check), the runtime
    // restarted, and only the reply was re-delivered. The first message existed nowhere else.
    const f = await fixture();

    await f.run(() => {});

    const stashed = f.dispatcher.stashedMessages.get(f.session.name!) ?? [];
    expect(stashed.map((message) => message.pendingId)).toEqual([f.running.pendingId, f.reply.pendingId]);
  });
});
