import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { getOrCreateSession } from "../../router/sessions.js";
import { closeRouterDb } from "../../router/router-db.js";
import {
  createRuntimeBootEpoch,
  createRuntimeTurnAttempt,
  markRuntimeBootEpochGracefulStopped,
} from "../../runtime/crash-recovery-store.js";
import { clearRuntimeLiveState, noteRuntimeTurnSignal } from "../../runtime/live-state.js";
import { getSessionTurn, recordSessionEvent, upsertSessionTurn } from "../../session-trace/session-trace-db.js";
import { recordTerminalTurnTrace } from "../../session-trace/runtime-trace.js";
import { recordDeliveryTrace } from "../../session-trace/channel-trace.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { listSlackThreadsForSession, reconcileSlackThreadLifecycle } from "./thread-lifecycle.js";
import { closeSlackThreadLifecycle, registerInboundSlackThread } from "./thread-lifecycle-store.js";
import { getThreadTurnHealth } from "./thread-turn-health-store.js";
import { THREAD_NO_SIGNAL_MS } from "./thread-turn-health.js";

let stateDir: string | null = null;
const parentKey = "health-parent";
const childKey = "health-parent:thread:1713000000.000100";
const childName = "health-child";
const requestId = "health-thread";
let now: number;
let startedAt: number;
let turnId: string;
let publishPrompt: ReturnType<typeof mock>;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-thread-turn-health-");
  now = Date.now();
  startedAt = now - 20 * 60_000;
  turnId = "health-turn-1";
  getOrCreateSession(parentKey, "main", "/tmp/ravi", { name: parentKey });
  getOrCreateSession(childKey, "main", "/tmp/ravi", { name: childName });
  registerInboundSlackThread({
    requestId,
    parentSessionKey: parentKey,
    parentSessionName: parentKey,
    childSessionKey: childKey,
    childSessionName: childName,
    accountId: "test-slack",
    instanceId: "test-slack",
    platformChatId: "C_TEST",
    threadCanonicalChatId: "chat-thread-test",
    providerThreadId: "1713000000.000100",
    seenAt: startedAt,
  });
  seedTurn();
  publishPrompt = mock(async () => {});
});
afterEach(async () => {
  clearRuntimeLiveState(childName);
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function seedTurn() {
  upsertSessionTurn({
    turnId,
    sessionKey: childKey,
    sessionName: childName,
    runId: "health-run",
    status: "running",
    startedAt,
    updatedAt: startedAt,
  });
  event("adapter.request", startedAt);
}
function event(eventType: string, timestamp: number, payloadJson: Record<string, unknown> = {}) {
  recordSessionEvent({
    sessionKey: childKey,
    sessionName: childName,
    turnId,
    eventType,
    eventGroup: "runtime",
    timestamp,
    payloadJson,
  });
}
function terminal(status: "complete" | "interrupted" | "failed", outputState?: "final" | "incomplete" | "silent") {
  recordTerminalTurnTrace({
    sessionKey: childKey,
    sessionName: childName,
    turnId,
    status,
    eventType: status === "complete" ? "turn.complete" : status === "failed" ? "turn.failed" : "turn.interrupted",
    outputState,
    completedAt: now - 61_000,
    abortReason: status === "interrupted" ? "user_interrupt" : null,
  });
}
async function tick() {
  const result = await reconcileSlackThreadLifecycle({
    publishPrompt,
    publishEvent: mock(async () => {}),
    now: () => now,
  });
  expect(result.failures).toBe(0);
  return getThreadTurnHealth(requestId);
}
function lease(expiresAt: number) {
  const boot = createRuntimeBootEpoch({
    instanceId: "health-test",
    pid: process.pid,
    startedAt,
    lastHeartbeatAt: startedAt,
    leaseExpiresAt: expiresAt,
  });
  createRuntimeTurnAttempt({
    turnId,
    runId: "health-run",
    sessionKey: childKey,
    sessionName: childName,
    agentId: "main",
    provider: "codex",
    model: "test",
    bootEpoch: boot.bootEpoch,
    startedAt,
    lastHeartbeatAt: startedAt,
    leaseExpiresAt: expiresAt,
    checkpoint: {},
    originKind: "human",
    deliveryBarrier: "after_tool",
  });
  return boot;
}

describe("thread turn health reconciliation", () => {
  it("makes an unterminated turn visible and sends one notice across ticks and database reopen", async () => {
    expect(await tick()).toMatchObject({ state: "attention", reason: "no_signal", turnId });
    closeRouterDb();
    now += 30_000;
    expect(await tick()).toMatchObject({ state: "attention", reason: "no_signal" });
    expect(publishPrompt).toHaveBeenCalledTimes(1);
    expect(getSessionTurn(turnId)?.completedAt).toBeNull();
    expect(publishPrompt.mock.calls[0]?.[1]).toMatchObject({
      _slackThreadLifecycle: { eventType: "thread.attention", turnId, reason: "no_signal" },
    });
  });

  it("does not mistake partial output before a tool for a completed turn", async () => {
    event("assistant.message", startedAt + 1000, { chars: 80 });
    event("tool.end", startedAt + 2000, { toolId: "tool-1" });
    upsertSessionTurn({ turnId, sessionKey: childKey, status: "running", outputState: "final" });
    expect(await tick()).toMatchObject({ state: "attention", reason: "no_signal" });
    expect(getSessionTurn(turnId)?.completedAt).toBeNull();
  });

  it("uses real provider activity for a long turn, without treating host leases as progress", async () => {
    lease(now + 120_000);
    noteRuntimeTurnSignal(childName, turnId, now - 1000);
    expect(await tick()).toMatchObject({ state: "running", reason: null });
    clearRuntimeLiveState(childName);
    expect(await tick()).toMatchObject({ state: "attention", reason: "no_signal" });
  });

  it("honors a long tool budget and never converts mere silence to failure", async () => {
    event("tool.start", startedAt, { toolId: "expensive", toolName: "bash", input: { timeout: 1800 } });
    expect(await tick()).toMatchObject({ state: "running" });
    expect(publishPrompt).not.toHaveBeenCalled();
    now += 40 * 60_000;
    expect(await tick()).toMatchObject({ state: "attention", reason: "no_signal" });
    expect(getSessionTurn(turnId)?.status).toBe("running");
  });

  it("classifies real owner loss from attempt/boot leases, even with recent output", async () => {
    lease(now - 1);
    event("assistant.message", now - 100);
    expect(await tick()).toMatchObject({ state: "attention", reason: "owner_lost" });
  });

  it("detects a stopped owner before its attempt lease expires", async () => {
    const boot = lease(now + 120_000);
    markRuntimeBootEpochGracefulStopped({ bootEpoch: boot.bootEpoch, stoppedAt: now });
    noteRuntimeTurnSignal(childName, turnId, now);
    expect(await tick()).toMatchObject({ state: "attention", reason: "owner_lost" });
  });

  it("does not send another notice when no_signal evolves into owner_lost", async () => {
    lease(now + 120_000);
    expect(await tick()).toMatchObject({ reason: "no_signal" });
    now += 120_001;
    expect(await tick()).toMatchObject({ reason: "owner_lost" });
    expect(publishPrompt).toHaveBeenCalledTimes(1);
  });

  it("keeps a human interruption separate from no_reply", async () => {
    terminal("interrupted");
    expect(await tick()).toMatchObject({ state: "interrupted", reason: null });
    expect(publishPrompt).not.toHaveBeenCalled();
  });

  it("does not alert for intentional silence with a terminal", async () => {
    terminal("complete", "silent");
    expect(await tick()).toMatchObject({ state: "idle", reason: null });
    expect(publishPrompt).not.toHaveBeenCalled();
  });

  it("reports a completed turn with only commentary as no_reply after its delivery grace", async () => {
    terminal("complete", "incomplete");
    event("response.emitted", now - 60_000, { textLen: 100, responsePhase: "commentary" });
    now -= 2000;
    expect(await tick()).toMatchObject({ state: "running" });
    now += 2000;
    expect(await tick()).toMatchObject({ state: "attention", reason: "no_reply" });
  });

  it("accepts a correlated final delivered only on the channel, and ignores other turns", async () => {
    terminal("complete");
    const delivery = { status: "delivered", responsePhase: "final_answer", textLen: 30 };
    recordDeliveryTrace({
      sessionName: childName,
      delivery: { ...delivery, traceTurnId: "other-turn" },
      timestamp: now,
    });
    expect(await tick()).toMatchObject({ reason: "no_reply" });
    recordDeliveryTrace({ sessionName: childName, delivery: { ...delivery, traceTurnId: turnId }, timestamp: now });
    expect(await tick()).toMatchObject({ state: "idle", reason: null });
  });

  it("preserves a confirmed failure as attention", async () => {
    terminal("failed");
    expect(await tick()).toMatchObject({ state: "attention", reason: "failed" });
  });

  it("lets close-thread during a tool take precedence over missing terminal", async () => {
    event("tool.start", now, { toolId: "open-tool" });
    expect(await tick()).toMatchObject({ state: "running" });
    closeSlackThreadLifecycle({ requestId, childSessionKey: childKey });
    now += THREAD_NO_SIGNAL_MS;
    expect(await tick()).toMatchObject({ state: "closed", reason: null });
    expect(publishPrompt).not.toHaveBeenCalled();
  });

  it("projects only the persisted observation in the list and clears it on new work", async () => {
    const parent = getOrCreateSession(parentKey, "main", "/tmp/ravi", { name: parentKey });
    expect(listSlackThreadsForSession(parent).threads[0]?.turnHealth).toBeNull();
    await tick();
    turnId = "health-turn-2";
    startedAt = now;
    seedTurn();
    expect(listSlackThreadsForSession(parent).threads[0]?.turnHealth?.reason).toBe("no_signal");
    await tick();
    expect(listSlackThreadsForSession(parent).threads[0]).toMatchObject({
      status: "open",
      turnHealth: { turnId, state: "running", reason: null },
    });
    now += THREAD_NO_SIGNAL_MS;
    await tick();
    expect(publishPrompt).toHaveBeenCalledTimes(2);
  });

  it("claims an occurrence once even when two ticks overlap", async () => {
    let release!: () => void;
    let entered!: () => void;
    const sending = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    publishPrompt = mock(async () => {
      entered();
      await blocked;
    });
    const first = tick();
    await sending;
    await tick();
    expect(publishPrompt).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it("retries publication failures with the same id and stops after success", async () => {
    publishPrompt = mock(async () => {
      throw new Error("transport unavailable");
    });
    const failed = await reconcileSlackThreadLifecycle({
      publishPrompt,
      publishEvent: mock(async () => {}),
      now: () => now,
    });
    expect(failed.failures).toBe(1);
    const firstId = publishPrompt.mock.calls[0]?.[2];
    publishPrompt = mock(async () => {});
    await tick();
    await tick();
    expect(publishPrompt).toHaveBeenCalledTimes(1);
    expect(publishPrompt.mock.calls[0]?.[2]).toEqual(firstId);
  });
});
