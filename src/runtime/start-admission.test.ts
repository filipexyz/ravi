import { configStore } from "../config-store.js";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createIsolatedRaviState, cleanupIsolatedRaviState } from "../test/ravi-state.js";
import { querySessionTrace } from "../session-trace/query.js";
import type { RuntimeCrashRecoveryCoordinator } from "./crash-recovery.js";
import type { RuntimeHostStreamingSession } from "./host-session.js";
import type { RuntimeLaunchPrompt } from "./message-types.js";
import { RuntimeSessionDispatcher } from "./session-dispatcher.js";
import * as launcher from "./session-launcher.js";
import { RuntimeStartCapacityError } from "./start-admission.js";
import { DEFAULT_RUNTIME_PENDING_START_TIMEOUT_MS, resolveRuntimePendingStartTimeoutMs } from "./session-pool.js";

let stateDir: string;
beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-start-admission-");
});
afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
});

function dispatcher(max = 2, reserved = 0) {
  return new RuntimeSessionDispatcher({
    instanceId: "test",
    maxConcurrentSessions: max,
    interactiveReservedSessions: reserved,
    safeEmit: async () => {},
    notifyRuntimeRecoveryExhausted: async () => {},
    getConfigModel: () => "test",
    idleSessionTtlMs: 0,
    crashRecovery: { acceptingDeliveries: true } as RuntimeCrashRecoveryCoordinator,
  });
}
function session(overrides: Partial<RuntimeHostStreamingSession> = {}): RuntimeHostStreamingSession {
  return {
    agentId: "test",
    done: false,
    starting: false,
    turnActive: false,
    compacting: false,
    toolRunning: false,
    pendingWake: false,
    pendingMessages: [],
    lastActivity: Date.now(),
    abortController: new AbortController(),
    queryHandle: { provider: "codex", interrupt: async () => {}, events: (async function* () {})() },
    ...overrides,
  } as RuntimeHostStreamingSession;
}
function reserve(d: RuntimeSessionDispatcher, name: string, prompt: RuntimeLaunchPrompt = { prompt: "hello" }) {
  return (
    d as unknown as {
      reserveRuntimeSessionStart(name: string, prompt: RuntimeLaunchPrompt): Promise<boolean>;
    }
  ).reserveRuntimeSessionStart(name, prompt);
}

describe("immediate runtime admission", () => {
  it("evicts the least recently active idle session even when idle TTL is disabled", async () => {
    const d = dispatcher();
    const older = session({ lastActivity: Date.now() - 50 });
    const newer = session();
    d.streamingSessions.set("older", older);
    d.streamingSessions.set("newer", newer);
    expect(await reserve(d, "incoming")).toBe(true);
    expect(older.done).toBe(true);
    expect(newer.done).toBe(false);
    expect(d.streamingSessions.has("older")).toBe(false);
    expect(d.startReservations.has("incoming")).toBe(true);
    expect(d.pendingStarts).toHaveLength(0);
  });

  it.each([
    { turnActive: true },
    { starting: true },
    { toolRunning: true },
    { compacting: true },
    { toolResultDeliveryPending: true },
    { pendingWake: true },
    { pendingMessages: [{}] as RuntimeHostStreamingSession["pendingMessages"] },
  ])("does not evict serving work: %j", async (state) => {
    const d = dispatcher(1);
    const busy = session(state);
    d.streamingSessions.set("busy", busy);
    await expect(reserve(d, "incoming")).rejects.toBeInstanceOf(RuntimeStartCapacityError);
    expect(busy.done).toBe(false);
    expect(d.pendingStarts).toHaveLength(0);
  });

  it("reclaims enough idle entries to open the background lane, preserving the interactive reserve", async () => {
    const d = dispatcher(3, 1);
    d.streamingSessions.set("working", session({ turnActive: true }));
    d.streamingSessions.set("idle1", session());
    d.streamingSessions.set("idle2", session());
    expect(await reserve(d, "background", { prompt: "tick", _cron: true })).toBe(true);
    expect(d.streamingSessions.size).toBe(1);
    await expect(reserve(d, "background2", { prompt: "tick", _cron: true })).rejects.toMatchObject({
      capacity: { reason: "interactive_reserved_capacity" },
    });
    expect(await reserve(d, "human")).toBe(true);
    expect(d.startReservations.size).toBe(2);
  });

  it("preserves idle sessions when reclaiming every candidate cannot admit the background lane", async () => {
    const d = dispatcher(3, 1);
    d.streamingSessions.set("working", session({ turnActive: true }));
    d.startReservations.add("starting");
    const idle = session();
    d.streamingSessions.set("idle", idle);
    await expect(reserve(d, "background", { prompt: "tick", _cron: true })).rejects.toBeInstanceOf(
      RuntimeStartCapacityError,
    );
    expect(idle.done).toBe(false);
    expect(d.streamingSessions.has("idle")).toBe(true);
    expect(d.startReservations.has("background")).toBe(false);
  });

  it("starts B and C independently while A's cold start is blocked; reservations bound concurrency", async () => {
    const d = dispatcher(3);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const launch = spyOn(launcher, "startRuntimeSession").mockImplementation(async ({ sessionName }) => {
      calls.push(sessionName);
      if (sessionName === "A") await gate;
      d.streamingSessions.set(sessionName, session({ turnActive: true }));
    });
    const a = d.startStreamingSession("A", { prompt: "A" });
    try {
      await Promise.all([d.startStreamingSession("B", { prompt: "B" }), d.startStreamingSession("C", { prompt: "C" })]);
      expect(calls).toEqual(["A", "B", "C"]);
      expect(d.startingSessions.has("A")).toBe(true);
      await expect(d.startStreamingSession("D", { prompt: "D" })).rejects.toBeInstanceOf(RuntimeStartCapacityError);
      expect(calls).toHaveLength(3);
    } finally {
      release();
      await a;
      launch.mockRestore();
    }
  });

  it("restores held context and deferred bootstrap when admission is refused", async () => {
    configStore.refresh();
    const d = dispatcher(1);
    d.streamingSessions.set("busy", session({ turnActive: true }));
    const bootstrap = { prompt: "group context" };
    d.heldSkipTurnMessages.set("incoming", ["remembered note"]);
    d.deferredBootstraps.set("incoming", bootstrap);
    await expect(d.handlePromptImmediate("incoming", { prompt: "new request" })).rejects.toBeInstanceOf(
      RuntimeStartCapacityError,
    );
    expect(d.heldSkipTurnMessages.get("incoming")).toEqual(["remembered note"]);
    expect(d.deferredBootstraps.get("incoming")).toEqual(bootstrap);
  });

  it("drains remaining waiters FIFO and reserves every free slot without waiting for a launch", () => {
    const d = dispatcher(2);
    const order: string[] = [];
    d.streamingSessions.set("busy1", session({ turnActive: true }));
    d.streamingSessions.set("busy2", session({ turnActive: true }));
    for (const name of ["first", "second", "third"])
      d.pendingStarts.push({
        sessionName: name,
        prompt: { prompt: name },
        resolve: () => {
          order.push(name);
        },
        reject: () => {},
      });
    d.drainPendingStarts();
    expect(order).toEqual([]);
    d.streamingSessions.clear();
    d.drainPendingStarts();
    expect(order).toEqual(["first", "second"]);
    expect([...d.startReservations]).toEqual(["first", "second"]);
    expect(d.pendingStarts.map((p) => p.sessionName)).toEqual(["third"]);
  });

  it("uses an independent 30s queue watchdog, regardless of idle TTL", () => {
    const previous = process.env.RAVI_RUNTIME_IDLE_SESSION_TTL_MS;
    const previousQueue = process.env.RAVI_RUNTIME_PENDING_START_TIMEOUT_MS;
    try {
      delete process.env.RAVI_RUNTIME_PENDING_START_TIMEOUT_MS;
      for (const ttl of ["0", "1", "3600000"]) {
        process.env.RAVI_RUNTIME_IDLE_SESSION_TTL_MS = ttl;
        expect(resolveRuntimePendingStartTimeoutMs()).toBe(DEFAULT_RUNTIME_PENDING_START_TIMEOUT_MS);
      }
      process.env.RAVI_RUNTIME_PENDING_START_TIMEOUT_MS = "12345";
      expect(resolveRuntimePendingStartTimeoutMs()).toBe(12345);
    } finally {
      if (previous === undefined) delete process.env.RAVI_RUNTIME_IDLE_SESSION_TTL_MS;
      else process.env.RAVI_RUNTIME_IDLE_SESSION_TTL_MS = previous;
      if (previousQueue === undefined) delete process.env.RAVI_RUNTIME_PENDING_START_TIMEOUT_MS;
      else process.env.RAVI_RUNTIME_PENDING_START_TIMEOUT_MS = previousQueue;
    }
  });

  it("rejects a timed-out waiter back to its durable caller, with position and occupants", async () => {
    const d = dispatcher(1);
    d.streamingSessions.set("busy", session({ turnActive: true }));
    const original = { prompt: "must survive", source: { channel: "slack", accountId: "test", chatId: "C1" } };
    const completion = new Promise<void>((resolve, reject) => {
      d.pendingStarts.push({
        sessionName: "waiting",
        prompt: original,
        resolve,
        reject,
        lane: "interactive",
        queuedAt: Date.now() - 31_000,
      });
    });
    d.reclaimNonServingRuntimeSessions();
    await expect(completion).rejects.toMatchObject({
      capacity: {
        reason: "pending_start_timeout",
        queuePosition: 1,
        occupants: [{ sessionName: "busy", state: "running" }],
      },
    });
    expect(d.pendingStarts).toHaveLength(0);
    const trace = querySessionTrace({ sessionKey: "waiting", only: "dispatch" });
    expect(trace.events.find((e) => e.eventType === "dispatch.start_timeout")?.payloadJson).toMatchObject({
      retryable: true,
      queuePosition: 1,
    });
    expect(original.prompt).toBe("must survive");
  });
});
