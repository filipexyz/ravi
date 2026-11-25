import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  createRuntimeBootEpoch,
  getRuntimeBootEpoch,
  getRuntimeTurnAttempt,
  hasLaterRuntimeTurnAttempt,
  listRuntimeBootEpochs,
  listRuntimeTurnAttempts,
  markRuntimeBootEpochAbandoned,
  markRuntimeTurnAttemptRestartRecovery,
  markRuntimeTurnAttemptSafety,
  createRuntimeTurnAttempt,
  terminalizeRuntimeTurnAttempt,
} from "./crash-recovery-store.js";
import type { TurnOrigin } from "./turn-provenance.js";
import {
  claimRestartInterruptedAttempt,
  type OrphanedRestartTurnDeps,
  type RestartAttemptStore,
  recoverOrphanedRestartTurns,
} from "./restart-turn-recovery.js";

const NOW = 10_000_000;
const WINDOW_MS = 60 * 60 * 1000;
const DEAD_PID = 4242;
const LIVE_PID = 5151;

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-restart-turn-recovery-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function createBoot(bootEpoch: string, input: { pid?: number; lastHeartbeatAt?: number; leaseMs?: number } = {}) {
  const lastHeartbeatAt = input.lastHeartbeatAt ?? NOW - 130_000;
  return createRuntimeBootEpoch({
    bootEpoch,
    instanceId: `instance-${bootEpoch}`,
    pid: input.pid ?? DEAD_PID,
    startedAt: lastHeartbeatAt - 600_000,
    lastHeartbeatAt,
    leaseExpiresAt: lastHeartbeatAt + (input.leaseMs ?? 120_000),
  });
}

function createAttempt(input: {
  attemptId: string;
  bootEpoch: string;
  sessionKey?: string;
  sessionName?: string;
  startedAt?: number;
  originKind?: TurnOrigin;
  startedTool?: boolean;
}) {
  const startedAt = input.startedAt ?? NOW - 135_000;
  createRuntimeTurnAttempt({
    attemptId: input.attemptId,
    turnId: `turn-${input.attemptId}`,
    runId: `run-${input.attemptId}`,
    sessionKey: input.sessionKey ?? "agent:main:main:thread:1",
    sessionName: input.sessionName ?? "main-t-1",
    agentId: "main",
    provider: "claude",
    model: "opus",
    bootEpoch: input.bootEpoch,
    startedAt,
    lastHeartbeatAt: startedAt,
    leaseExpiresAt: startedAt + 120_000,
    requestBlobSha256: `request-${input.attemptId}`,
    originKind: input.originKind ?? "agent",
    source: { channel: "slack", accountId: "ravi-slack", chatId: "D1", threadId: "1" },
    deliveryBarrier: "after_response",
    pendingIds: [],
  });
  if (input.startedTool ?? true) {
    markRuntimeTurnAttemptSafety({ attemptId: input.attemptId, startedTool: true, markedAt: startedAt + 1 });
  }
}

const realStore: RestartAttemptStore = {
  getAttempt: getRuntimeTurnAttempt,
  hasLaterAttempt: hasLaterRuntimeTurnAttempt,
  terminalizeInterrupted(attempt, completedAt) {
    try {
      terminalizeRuntimeTurnAttempt({ attemptId: attempt.attemptId, status: "interrupted", completedAt });
      return true;
    } catch {
      return false;
    }
  },
  markRecovery: (attemptId, status, reason, at) =>
    markRuntimeTurnAttemptRestartRecovery({ attemptId, status, reason, recoveredAt: at }),
};

function harness(options: { delivered?: string[]; missingSessions?: string[] } = {}) {
  const deliveries: Array<{ kind: string; sessionName: string; attemptId: string }> = [];
  const deps: OrphanedRestartTurnDeps = {
    ...realStore,
    now: () => NOW,
    listActiveBootEpochs: () => listRuntimeBootEpochs({ status: "active", limit: 200 }),
    abandonBootEpoch(boot, at) {
      try {
        markRuntimeBootEpochAbandoned({
          bootEpoch: boot.bootEpoch,
          abandonedAt: Math.max(at, boot.lastHeartbeatAt, boot.updatedAt),
          reason: "test",
          expectedLastHeartbeatAt: boot.lastHeartbeatAt,
          expectedLeaseExpiresAt: boot.leaseExpiresAt,
        });
        return true;
      } catch {
        return false;
      }
    },
    listRunningAttempts: (bootEpoch) => listRuntimeTurnAttempts({ bootEpoch, status: "running", limit: 1000 }),
    hasDelivery: (_epoch, sessionKey) => (options.delivered ?? []).includes(sessionKey),
    resolveSessionName: (attempt) =>
      (options.missingSessions ?? []).includes(attempt.sessionKey) ? null : (attempt.sessionName ?? null),
    isTerminalTaskSession: () => false,
    deliver: async ({ claim, sessionName }) => {
      deliveries.push({ kind: claim.kind, sessionName, attemptId: claim.attempt.attemptId });
      return true;
    },
  };
  return { deps, deliveries };
}

function recover(deps: OrphanedRestartTurnDeps) {
  return recoverOrphanedRestartTurns(
    { restartEpoch: "restart-epoch-1", currentBootEpoch: "boot-live", windowMs: WINDOW_MS },
    deps,
  );
}

describe("orphaned turn recovery after an unclean restart", () => {
  it("resumes the turn a SIGKILLed boot left running, exactly once", async () => {
    createBoot("boot-live", { pid: 7777, lastHeartbeatAt: NOW });
    createBoot("boot-dead");
    createAttempt({ attemptId: "attempt-1", bootEpoch: "boot-dead" });
    const { deps, deliveries } = harness();

    const first = await recover(deps);

    expect(first.resumed).toEqual(["main-t-1"]);
    expect(deliveries).toEqual([{ kind: "resume", sessionName: "main-t-1", attemptId: "attempt-1" }]);
    expect(getRuntimeTurnAttempt("attempt-1")).toMatchObject({
      status: "interrupted",
      recoveryStatus: "restart_resumed",
      recoveryReason: "verify_continue",
    });
    expect(getRuntimeBootEpoch("boot-dead")?.status).toBe("abandoned");
    expect(getRuntimeBootEpoch("boot-live")?.status).toBe("active");

    const second = await recover(deps);
    expect(second.resumed).toEqual([]);
    expect(deliveries).toHaveLength(1);
  });

  it("never resumes the same attempt twice, even when claimed again directly", () => {
    createBoot("boot-dead");
    createAttempt({ attemptId: "attempt-1", bootEpoch: "boot-dead" });

    const first = claimRestartInterruptedAttempt({ attemptId: "attempt-1", now: NOW }, realStore);
    const second = claimRestartInterruptedAttempt({ attemptId: "attempt-1", now: NOW + 1 }, realStore);

    expect(first.kind).toBe("resume");
    expect(second).toMatchObject({ kind: "skip", reason: "already_recovered" });
  });

  it("lets only one of two racing claims resume, even when the loser read the attempt before the winner marked it", () => {
    createBoot("boot-dead");
    createAttempt({ attemptId: "attempt-1", bootEpoch: "boot-dead" });
    const staleRead = getRuntimeTurnAttempt("attempt-1");
    expect(staleRead?.recoveryStatus).toBeNull();

    const winner = claimRestartInterruptedAttempt({ attemptId: "attempt-1", now: NOW }, realStore);
    let reads = 0;
    const loserStore: RestartAttemptStore = {
      ...realStore,
      getAttempt: (attemptId) => (reads++ === 0 ? staleRead : getRuntimeTurnAttempt(attemptId)),
    };
    const loser = claimRestartInterruptedAttempt({ attemptId: "attempt-1", now: NOW + 1 }, loserStore);

    expect(winner.kind).toBe("resume");
    expect(loser).toMatchObject({ kind: "skip", reason: "already_recovered" });
  });

  it("only notifies a turn that was itself a restart resume, so a crashing turn cannot loop", async () => {
    createBoot("boot-live", { pid: 7777, lastHeartbeatAt: NOW });
    createBoot("boot-dead");
    createAttempt({ attemptId: "attempt-resumed", bootEpoch: "boot-dead", originKind: "daemon-restart" });
    const { deps, deliveries } = harness();

    const outcome = await recover(deps);

    expect(outcome.resumed).toEqual([]);
    expect(outcome.noticed).toEqual(["main-t-1"]);
    expect(deliveries).toEqual([{ kind: "loop", sessionName: "main-t-1", attemptId: "attempt-resumed" }]);
    expect(getRuntimeTurnAttempt("attempt-resumed")?.recoveryStatus).toBe("restart_noticed");
  });

  it("resumes only the newest interrupted turn of a session", async () => {
    createBoot("boot-live", { pid: 7777, lastHeartbeatAt: NOW });
    createBoot("boot-dead");
    createAttempt({ attemptId: "attempt-old", bootEpoch: "boot-dead", startedAt: NOW - 140_000 });
    createAttempt({ attemptId: "attempt-new", bootEpoch: "boot-dead", startedAt: NOW - 135_000 });
    const { deps, deliveries } = harness();

    await recover(deps);

    expect(deliveries.map((delivery) => delivery.attemptId)).toEqual(["attempt-new"]);
    expect(getRuntimeTurnAttempt("attempt-old")).toMatchObject({
      status: "interrupted",
      recoveryStatus: "restart_skipped",
      recoveryReason: "superseded",
    });
  });

  it("leaves a session alone when it already started a turn after the interrupted one", async () => {
    createBoot("boot-live", { pid: 7777, lastHeartbeatAt: NOW });
    createBoot("boot-dead");
    createAttempt({ attemptId: "attempt-dead", bootEpoch: "boot-dead", startedAt: NOW - 135_000 });
    createAttempt({ attemptId: "attempt-live", bootEpoch: "boot-live", startedAt: NOW - 1_000 });
    const { deps, deliveries } = harness();

    await recover(deps);

    expect(deliveries).toEqual([]);
    expect(getRuntimeTurnAttempt("attempt-dead")?.recoveryReason).toBe("superseded");
    expect(getRuntimeTurnAttempt("attempt-live")?.status).toBe("running");
  });

  it("does not touch a previous boot still inside its lease, and asks to look again at its expiry", async () => {
    createBoot("boot-live", { pid: 7777, lastHeartbeatAt: NOW });
    const maybeAlive = createBoot("boot-maybe-alive", { pid: LIVE_PID, lastHeartbeatAt: NOW - 5_000 });
    createAttempt({ attemptId: "attempt-1", bootEpoch: "boot-maybe-alive", startedAt: NOW - 10_000 });
    const { deps, deliveries } = harness();

    const outcome = await recover(deps);

    expect(deliveries).toEqual([]);
    expect(outcome.retryAt).toBe(maybeAlive.leaseExpiresAt);
    expect(outcome.pending).toEqual(["main-t-1"]);
    expect(getRuntimeBootEpoch("boot-maybe-alive")?.status).toBe("active");
    expect(getRuntimeTurnAttempt("attempt-1")?.status).toBe("running");
  });

  it("recovers once the previous boot's lease expired, whatever its pid", async () => {
    createBoot("boot-live", { pid: 7777, lastHeartbeatAt: NOW });
    createBoot("boot-expired", { pid: LIVE_PID, lastHeartbeatAt: NOW - 130_000 });
    createAttempt({ attemptId: "attempt-1", bootEpoch: "boot-expired", startedAt: NOW - 140_000 });
    const { deps, deliveries } = harness();

    await recover(deps);

    expect(deliveries.map((delivery) => delivery.attemptId)).toEqual(["attempt-1"]);
  });

  it("ignores boots that died outside the resume window", async () => {
    createBoot("boot-live", { pid: 7777, lastHeartbeatAt: NOW });
    createBoot("boot-ancient", { lastHeartbeatAt: NOW - WINDOW_MS - 1 });
    createAttempt({ attemptId: "attempt-1", bootEpoch: "boot-ancient", startedAt: NOW - WINDOW_MS - 10_000 });
    const { deps, deliveries } = harness();

    await recover(deps);

    expect(deliveries).toEqual([]);
    expect(getRuntimeBootEpoch("boot-ancient")?.status).toBe("active");
    expect(getRuntimeTurnAttempt("attempt-1")?.status).toBe("running");
  });

  it("skips background origins, missing sessions and sessions the restart snapshot already handled", async () => {
    createBoot("boot-live", { pid: 7777, lastHeartbeatAt: NOW });
    createBoot("boot-dead");
    createAttempt({ attemptId: "attempt-observer", bootEpoch: "boot-dead", sessionKey: "obs", originKind: "observer" });
    createAttempt({ attemptId: "attempt-gone", bootEpoch: "boot-dead", sessionKey: "gone" });
    createAttempt({ attemptId: "attempt-snap", bootEpoch: "boot-dead", sessionKey: "snap" });
    const { deps, deliveries } = harness({ missingSessions: ["gone"], delivered: ["snap"] });

    const outcome = await recover(deps);

    expect(deliveries).toEqual([]);
    expect(Object.fromEntries(outcome.skipped.map((entry) => [entry.attemptId, entry.reason]))).toEqual({
      "attempt-observer": "origin_not_resumable",
      "attempt-gone": "session_missing",
      "attempt-snap": "restart_event_delivered",
    });
    for (const attemptId of ["attempt-observer", "attempt-gone", "attempt-snap"]) {
      expect(getRuntimeTurnAttempt(attemptId)).toMatchObject({
        status: "interrupted",
        recoveryStatus: "restart_skipped",
      });
    }
  });

  it("does nothing without its own boot epoch", async () => {
    createBoot("boot-dead");
    createAttempt({ attemptId: "attempt-1", bootEpoch: "boot-dead" });
    const { deps, deliveries } = harness();

    const outcome = await recoverOrphanedRestartTurns(
      { restartEpoch: "restart-epoch-1", currentBootEpoch: null, windowMs: WINDOW_MS },
      deps,
    );

    expect(outcome.resumed).toEqual([]);
    expect(deliveries).toEqual([]);
    expect(getRuntimeTurnAttempt("attempt-1")?.status).toBe("running");
  });
});
