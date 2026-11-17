import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getSlackThreadLifecycle, registerInboundSlackThread } from "../channels/slack/thread-lifecycle-store.js";
import { observeThreadTurn, THREAD_NO_SIGNAL_MS } from "../channels/slack/thread-turn-health.js";
import { getDb } from "../router/router-db.js";
import { getOrCreateSession } from "../router/sessions.js";
import { recordSessionEvent, upsertSessionTurn } from "../session-trace/session-trace-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState, withoutRaviRuntimeContextEnv } from "../test/ravi-state.js";
import {
  acquireRuntimeRecoveryClaim,
  createRuntimeBootEpoch,
  createRuntimeRecoveryRun,
  createRuntimeTurnAttempt,
  heartbeatRuntimeBootEpoch,
  heartbeatRuntimeTurnAttempt,
  markRuntimeBootEpochGracefulStopped,
  recordRuntimeRecoveryCandidate,
  terminalizeRuntimeTurnAttempt,
} from "./crash-recovery-store.js";
import { clearRuntimeLiveState, noteRuntimeTurnSignal } from "./live-state.js";
import {
  createRuntimeTurnProgressRecorder,
  getRuntimeTurnProgress,
  recordRuntimeTurnProgress,
  RUNTIME_TURN_PROGRESS_INTERVAL_MS,
  type RuntimeTurnProgressOwner,
} from "./turn-progress.js";

let stateDir: string | null = null;
let now: number;
let startedAt: number;
let owner: RuntimeTurnProgressOwner;
const sessionKey = "progress-child";
const requestId = "progress-thread";

function seedOwner(attemptId: string, turnId: string, at: number): RuntimeTurnProgressOwner {
  const boot = createRuntimeBootEpoch({
    instanceId: "progress-owner",
    pid: process.pid,
    startedAt: at,
    lastHeartbeatAt: at,
    leaseExpiresAt: now + 60 * 60_000,
  });
  upsertSessionTurn({ turnId, sessionKey, sessionName: sessionKey, startedAt: at, status: "running", updatedAt: at });
  return createRuntimeTurnAttempt({
    attemptId,
    turnId,
    sessionKey,
    sessionName: sessionKey,
    agentId: "main",
    runId: `run-${attemptId}`,
    provider: "codex",
    model: "test",
    bootEpoch: boot.bootEpoch,
    startedAt: at,
    lastHeartbeatAt: at,
    leaseExpiresAt: now + 60 * 60_000,
    checkpoint: {},
    originKind: "human",
    deliveryBarrier: "after_tool",
  });
}

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-turn-progress-");
  now = Date.now();
  startedAt = now - 20 * 60_000;
  getOrCreateSession("progress-parent", "main", "/tmp", { name: "progress-parent" });
  getOrCreateSession(sessionKey, "main", "/tmp", { name: sessionKey });
  registerInboundSlackThread({
    requestId,
    parentSessionKey: "progress-parent",
    parentSessionName: "progress-parent",
    childSessionKey: sessionKey,
    childSessionName: sessionKey,
    accountId: "test-slack",
    instanceId: "test-slack",
    platformChatId: "C_TEST",
    providerThreadId: "1713000000.001",
    threadCanonicalChatId: "progress-chat",
    seenAt: startedAt,
  });
  owner = seedOwner("attempt-old", "turn-old", startedAt);
});

afterEach(async () => {
  clearRuntimeLiveState(sessionKey);
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function observe() {
  return observeThreadTurn(getSlackThreadLifecycle(requestId)!, now);
}

function spawnChild(source: string) {
  // The parent fixture owns the global test lock. Children share ONLY that
  // fixture's database, never acquire another fixture or inherit runtime auth.
  return spawnSync(
    process.execPath,
    ["--no-env-file", "--preload", "./src/test/shared-state-child-preload.ts", "--eval", source],
    {
      cwd: new URL("../..", import.meta.url),
      env: {
        ...withoutRaviRuntimeContextEnv(),
        RAVI_STATE_DIR: stateDir!,
        RAVI_SUPPRESS_AUDIT_EVENTS: "1",
        NATS_URL: "nats://127.0.0.1:1",
      },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
}

function childResult(source: string): unknown {
  const child = spawnChild(source);
  expect(child.status, child.stderr).toBe(0);
  const result = child.stdout.split("\n").find((line) => line.startsWith("PROGRESS_RESULT="));
  expect(result, child.stdout).toBeDefined();
  return JSON.parse(result!.slice("PROGRESS_RESULT=".length));
}

describe("shared runtime turn progress", () => {
  it("blocks child SQLite opens outside shared fixture state even when the error is caught", () => {
    const outside = `${stateDir!}-forbidden.sqlite`;
    try {
      const child = spawnChild(`
        import { Database } from "bun:sqlite";
        try { new Database(${JSON.stringify(outside)}); } catch {}
        console.log("blocked-open-was-caught");
      `);
      expect(child.status, child.stderr).toBe(24);
      expect(existsSync(outside)).toBe(false);
      // Legitimate opens still target the original fixture, not a fresh sandbox.
      expect(existsSync(join(stateDir!, "ravi.db"))).toBe(true);
    } finally {
      // A guard regression may have created only this fixture-specific sibling.
      rmSync(outside, { force: true });
    }
  });

  it("shares real owner activity with a separate reconciler process, then detects real silence", () => {
    expect(observe()).toMatchObject({ state: "attention", reason: "no_signal" });
    const progressModule = new URL("./turn-progress.ts", import.meta.url).href;
    const liveModule = new URL("./live-state.ts", import.meta.url).href;
    expect(
      childResult(`
        import { recordRuntimeTurnProgress } from ${JSON.stringify(progressModule)};
        import { noteRuntimeTurnSignal } from ${JSON.stringify(liveModule)};
        noteRuntimeTurnSignal(${JSON.stringify(sessionKey)}, ${JSON.stringify(owner.turnId)}, ${now});
        const result = recordRuntimeTurnProgress(${JSON.stringify(owner)}, ${now}, () => ${now});
        console.log("PROGRESS_RESULT=" + JSON.stringify(result));
      `),
    ).toBe(true);
    const observerModule = new URL("../channels/slack/thread-turn-health.ts", import.meta.url).href;
    const lifecycleModule = new URL("../channels/slack/thread-lifecycle-store.ts", import.meta.url).href;
    const observed = childResult(`
      import { observeThreadTurn } from ${JSON.stringify(observerModule)};
      import { getSlackThreadLifecycle } from ${JSON.stringify(lifecycleModule)};
      console.log("PROGRESS_RESULT=" + JSON.stringify(observeThreadTurn(getSlackThreadLifecycle(${JSON.stringify(requestId)}), ${now})));
    `);
    expect(observed).toMatchObject({ state: "running", reason: null, lastSignalAt: now });
    expect(observe()).toMatchObject({ state: "running", reason: null, lastSignalAt: now });
    now += THREAD_NO_SIGNAL_MS + RUNTIME_TURN_PROGRESS_INTERVAL_MS;
    expect(observe()).toMatchObject({ state: "attention", reason: "no_signal" });
  });

  it("never treats boot/attempt heartbeats or an unfenced local signal as provider progress", () => {
    heartbeatRuntimeBootEpoch({ bootEpoch: owner.bootEpoch, heartbeatAt: now, leaseExpiresAt: now + 61 * 60_000 });
    heartbeatRuntimeTurnAttempt({
      attemptId: owner.attemptId,
      bootEpoch: owner.bootEpoch,
      heartbeatAt: now,
      leaseExpiresAt: now + 61 * 60_000,
    });
    noteRuntimeTurnSignal(sessionKey, owner.turnId, now);
    expect(getRuntimeTurnProgress(owner)).toBeNull();
    expect(observe()).toMatchObject({ state: "attention", reason: "no_signal", lastSignalAt: startedAt });
  });

  it("throttles per attempt in storage and in the host recorder without extending silence", () => {
    const record = createRuntimeTurnProgressRecorder();
    expect(record(owner, now)).toBe(true);
    expect(record(owner, now)).toBe(false);
    expect(recordRuntimeTurnProgress(owner, now - 1, () => now)).toBe(false);
    expect(recordRuntimeTurnProgress(owner, now + 4999, () => now + 4999)).toBe(false);
    expect(getRuntimeTurnProgress(owner)).toBe(now);
    expect(recordRuntimeTurnProgress(owner, now + RUNTIME_TURN_PROGRESS_INTERVAL_MS, () => now + 5000)).toBe(true);
    expect(getRuntimeTurnProgress(owner)).toBe(now + 5000);
  });

  it("allows the bounded sample lag before declaring no_signal", () => {
    const sampledAt = now;
    expect(recordRuntimeTurnProgress(owner, sampledAt, () => sampledAt)).toBe(true);
    const lastActivityAt = sampledAt + RUNTIME_TURN_PROGRESS_INTERVAL_MS - 1;
    expect(recordRuntimeTurnProgress(owner, lastActivityAt, () => lastActivityAt)).toBe(false);
    now = sampledAt + THREAD_NO_SIGNAL_MS;
    expect(observe()).toMatchObject({ state: "running", reason: null });
    now += RUNTIME_TURN_PROGRESS_INTERVAL_MS;
    expect(observe()).toMatchObject({ state: "attention", reason: "no_signal" });
  });

  it("retains sample uncertainty when a trace arrives just after the sample", () => {
    const sampledAt = now;
    expect(recordRuntimeTurnProgress(owner, sampledAt, () => sampledAt)).toBe(true);
    recordSessionEvent({
      sessionKey,
      sessionName: sessionKey,
      turnId: owner.turnId,
      eventType: "assistant.message",
      eventGroup: "runtime",
      timestamp: sampledAt + 1,
      payloadJson: { textLen: 1 },
    });
    const finalActivity = sampledAt + RUNTIME_TURN_PROGRESS_INTERVAL_MS - 1;
    expect(recordRuntimeTurnProgress(owner, finalActivity, () => finalActivity)).toBe(false);
    now = sampledAt + THREAD_NO_SIGNAL_MS + 1;
    expect(observe()).toMatchObject({ state: "running", reason: null });
    now = sampledAt + THREAD_NO_SIGNAL_MS + RUNTIME_TURN_PROGRESS_INTERVAL_MS;
    expect(observe()).toMatchObject({ state: "attention", reason: "no_signal" });
  });

  it("throttles storage failures without turning the failed sample into progress", () => {
    const record = createRuntimeTurnProgressRecorder();
    getDb().exec(`CREATE TRIGGER fail_progress BEFORE INSERT ON runtime_turn_progress
      BEGIN SELECT RAISE(ABORT, 'progress unavailable'); END`);
    expect(() => record(owner, now)).toThrow("progress unavailable");
    getDb().exec("DROP TRIGGER fail_progress");
    expect(record(owner, now)).toBe(false);
    expect(getRuntimeTurnProgress(owner)).toBeNull();
    expect(observe()).toMatchObject({ state: "attention", reason: "no_signal" });
  });

  it("rejects a replaced physical turn without writing into its successor", () => {
    expect(recordRuntimeTurnProgress(owner, now, () => now)).toBe(true);
    const successor = seedOwner("attempt-successor", "turn-successor", now + 1);
    now += 10_000;
    expect(recordRuntimeTurnProgress(owner, now, () => now)).toBe(false);
    expect(recordRuntimeTurnProgress({ ...owner, turnId: successor.turnId }, now, () => now)).toBe(false);
    expect(getRuntimeTurnProgress(successor)).toBeNull();
    expect(recordRuntimeTurnProgress(successor, now, () => now)).toBe(true);
    expect(getRuntimeTurnProgress(owner)).toBe(now - 10_000);
  });

  it("fences a replaced attempt on the same physical turn and ignores its old watermark", () => {
    expect(recordRuntimeTurnProgress(owner, now, () => now)).toBe(true);
    const successor = seedOwner("attempt-successor", owner.turnId, startedAt + 1);
    now += 10_000;
    expect(recordRuntimeTurnProgress(owner, now, () => now)).toBe(false);
    expect(getRuntimeTurnProgress(successor)).toBeNull();
    expect(observe()).toMatchObject({ state: "attention", reason: "no_signal" });
    expect(recordRuntimeTurnProgress(successor, now, () => now)).toBe(true);
    expect(observe()).toMatchObject({ state: "running", lastSignalAt: now });
  });

  it("rejects progress after a recovery claim fences the owner", () => {
    const run = createRuntimeRecoveryRun({ mode: "apply", bootEpoch: owner.bootEpoch, startedAt: now });
    const candidate = recordRuntimeRecoveryCandidate({
      recoveryRunId: run.recoveryRunId,
      candidateType: "turn_attempt",
      sessionKey,
      attemptId: owner.attemptId,
      decision: "manual_review",
      reasonCode: "test-owner-fence",
      action: "inspect",
      recordedAt: now,
    });
    acquireRuntimeRecoveryClaim({
      recoveryRunId: run.recoveryRunId,
      candidateKey: candidate.candidateKey,
      claimedByBootEpoch: owner.bootEpoch,
      claimedAt: now,
    });
    expect(recordRuntimeTurnProgress(owner, now, () => now)).toBe(false);
    expect(getRuntimeTurnProgress(owner)).toBeNull();
  });

  it.each(["boot", "attempt", "terminal", "identity"] as const)("rejects an invalid %s fence", (kind) => {
    if (kind === "boot") markRuntimeBootEpochGracefulStopped({ bootEpoch: owner.bootEpoch, stoppedAt: now });
    if (kind === "attempt")
      getDb()
        .query("UPDATE runtime_turn_attempts SET lease_expires_at = ? WHERE attempt_id = ?")
        .run(now, owner.attemptId);
    if (kind === "terminal")
      terminalizeRuntimeTurnAttempt({ attemptId: owner.attemptId, status: "complete", completedAt: now });
    const input = kind === "identity" ? { ...owner, bootEpoch: "different-owner" } : owner;
    expect(recordRuntimeTurnProgress(input, now, () => now)).toBe(false);
    expect(getRuntimeTurnProgress(owner)).toBeNull();
  });

  it("rolls back progress if either captured lease expires while the write is blocked", () => {
    for (const table of ["runtime_boot_epochs", "runtime_turn_attempts"] as const) {
      const id = table === "runtime_boot_epochs" ? "boot_epoch" : "attempt_id";
      const value = table === "runtime_boot_epochs" ? owner.bootEpoch : owner.attemptId;
      getDb()
        .query(`UPDATE ${table} SET lease_expires_at = ? WHERE ${id} = ?`)
        .run(now + 1, value);
      let reads = 0;
      expect(recordRuntimeTurnProgress(owner, now, () => now + reads++)).toBe(false);
      expect(getRuntimeTurnProgress(owner)).toBeNull();
      getDb()
        .query(`UPDATE ${table} SET lease_expires_at = ? WHERE ${id} = ?`)
        .run(now + 60 * 60_000, value);
    }
  });
});
