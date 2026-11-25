import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { deleteSession, getOrCreateSession } from "../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  createRuntimeBootEpoch,
  createRuntimeTurnAttempt,
  getRuntimeBootEpoch,
  getRuntimeTurnAttempt,
  hasLaterRuntimeTurnAttempt,
  listRuntimeRecoveryCandidates,
  listRuntimeRecoveryRuns,
  markRuntimeBootEpochAbandoned,
  markRuntimeTurnAttemptSafety,
} from "./crash-recovery-store.js";
import { RESTART_TURN_AUTHORITY_METADATA_KEY } from "./daemon-restart-resume.js";
import type { TurnOrigin } from "./turn-provenance.js";
import {
  createLedgerOrphanedRestartTurnDeps,
  hasOrphanedRestartTurns,
  judgeRestartInterruptedAttempt,
  type OrphanedRestartTurnDeps,
  RESTART_RESUME_ATTEMPT_METADATA_KEY,
  recoverOrphanedRestartTurns,
  resolveOrphanedTurnSessionName,
  resolveOrphanedTurnSessionNameFromStore,
} from "./restart-turn-recovery.js";

const NOW = 10_000_000;
const WINDOW_MS = 60 * 60 * 1000;

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-restart-turn-recovery-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

/** Defaults to a boot that died: its last heartbeat is older than its 120 s lease. */
function createBoot(bootEpoch: string, input: { lastHeartbeatAt?: number } = {}) {
  const lastHeartbeatAt = input.lastHeartbeatAt ?? NOW - 130_000;
  return createRuntimeBootEpoch({
    bootEpoch,
    instanceId: `instance-${bootEpoch}`,
    pid: 4242,
    startedAt: lastHeartbeatAt - 600_000,
    lastHeartbeatAt,
    leaseExpiresAt: lastHeartbeatAt + 120_000,
  });
}

function createLiveBoot() {
  return createBoot("boot-live", { lastHeartbeatAt: NOW });
}

function createAttempt(input: {
  attemptId: string;
  bootEpoch: string;
  sessionKey?: string;
  sessionName?: string;
  startedAt?: number;
  originKind?: TurnOrigin;
  taskBarrierTaskId?: string;
  metadata?: Record<string, unknown>;
  /** Leave out the recorded authority envelope, like an attempt written before this release. */
  legacy?: boolean;
  turnProvenance?: Record<string, unknown>;
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
    taskBarrierTaskId: input.taskBarrierTaskId ?? null,
    deliveryBarrier: "after_response",
    ...(input.turnProvenance ? { turnProvenance: input.turnProvenance } : {}),
    pendingIds: [],
    metadata: {
      ...(input.legacy ? {} : { [RESTART_TURN_AUTHORITY_METADATA_KEY]: { v: 1 } }),
      ...(input.metadata ?? {}),
    },
  });
  markRuntimeTurnAttemptSafety({ attemptId: input.attemptId, startedTool: true, markedAt: startedAt + 1 });
}

function harness(
  options: { delivered?: string[]; missingSessions?: string[]; publishFails?: boolean; currentBootEpoch?: string } = {},
) {
  const deliveries: Array<{ kind: string; sessionName: string; attemptId: string }> = [];
  const deps: OrphanedRestartTurnDeps = {
    ...createLedgerOrphanedRestartTurnDeps(options.currentBootEpoch ?? "boot-live", { now: () => NOW }),
    hasDelivery: (_epoch, sessionKey) => (options.delivered ?? []).includes(sessionKey),
    resolveSessionName: (attempt) =>
      (options.missingSessions ?? []).includes(attempt.sessionKey) ? null : (attempt.sessionName ?? null),
    isTerminalTaskSession: () => false,
    deliver: async ({ verdict, sessionName }) => {
      if (options.publishFails) return false;
      deliveries.push({ kind: verdict.kind, sessionName, attemptId: verdict.attempt.attemptId });
      return true;
    },
  };
  return { deps, deliveries };
}

function recover(deps: OrphanedRestartTurnDeps, currentBootEpoch: string | null = "boot-live") {
  return recoverOrphanedRestartTurns({ restartEpoch: "restart-epoch-1", currentBootEpoch, windowMs: WINDOW_MS }, deps);
}

describe("orphaned turn recovery after an unclean restart", () => {
  it("resumes the turn a SIGKILLed boot left running, through a claimed apply run, exactly once", async () => {
    createLiveBoot();
    createBoot("boot-dead");
    createAttempt({ attemptId: "attempt-1", bootEpoch: "boot-dead" });
    const { deps, deliveries } = harness();

    const first = await recover(deps);

    expect(first.resumed).toEqual(["main-t-1"]);
    expect(deliveries).toEqual([{ kind: "resume", sessionName: "main-t-1", attemptId: "attempt-1" }]);
    expect(getRuntimeBootEpoch("boot-dead")?.status).toBe("abandoned");
    expect(getRuntimeBootEpoch("boot-live")?.status).toBe("active");
    const attempt = getRuntimeTurnAttempt("attempt-1");
    expect(attempt?.recoveryClaimId).not.toBeNull();
    expect(attempt?.recoveryStatus).toBe("resume");
    const [run] = listRuntimeRecoveryRuns();
    expect(run).toMatchObject({ mode: "apply", bootEpoch: "boot-live", status: "complete" });
    expect(listRuntimeRecoveryCandidates(run!.recoveryRunId)).toEqual([
      expect.objectContaining({
        attemptId: "attempt-1",
        decision: "resume",
        reasonCode: "verify_continue",
        action: "publish_verify_continue",
        actionStatus: "applied",
      }),
    ]);

    const second = await recover(deps);
    expect(second.resumed).toEqual([]);
    expect(second.recoveryRunId).toBeNull();
    expect(deliveries).toHaveLength(1);
  });

  it("lets only one of two racing passes act, even when the loser listed the attempt before the winner claimed it", async () => {
    createLiveBoot();
    createBoot("boot-dead");
    createAttempt({ attemptId: "attempt-1", bootEpoch: "boot-dead" });
    const winner = harness();
    const loser = harness();
    const staleListing = loser.deps.listRunningAttempts("boot-dead");
    loser.deps.listRunningAttempts = () => staleListing;
    loser.deps.listBootEpochs = () => [getRuntimeBootEpoch("boot-dead")!].map((boot) => ({ ...boot }));

    await recover(winner.deps);
    const lost = await recover(loser.deps);

    expect(winner.deliveries).toHaveLength(1);
    expect(loser.deliveries).toEqual([]);
    expect(lost.skipped).toEqual([expect.objectContaining({ attemptId: "attempt-1", reason: "claimed_elsewhere" })]);
  });

  it("only notifies a turn that was itself a restart resume, so a crashing turn cannot loop", async () => {
    createLiveBoot();
    createBoot("boot-dead");
    createAttempt({ attemptId: "attempt-resumed", bootEpoch: "boot-dead", originKind: "daemon-restart" });
    const { deps, deliveries } = harness();

    const outcome = await recover(deps);

    expect(outcome.resumed).toEqual([]);
    expect(outcome.noticed).toEqual(["main-t-1"]);
    expect(deliveries).toEqual([{ kind: "notice", sessionName: "main-t-1", attemptId: "attempt-resumed" }]);
    expect(getRuntimeTurnAttempt("attempt-resumed")?.recoveryStatus).toBe("reconcile_interrupted");
  });

  it("recognizes a task turn that was a restart resume by its attempt marker, not only its origin", async () => {
    createLiveBoot();
    createBoot("boot-dead");
    createAttempt({
      attemptId: "attempt-task-resume",
      bootEpoch: "boot-dead",
      originKind: "task",
      taskBarrierTaskId: "task-1",
      metadata: { [RESTART_RESUME_ATTEMPT_METADATA_KEY]: true },
    });
    const { deps, deliveries } = harness();

    await recover(deps);

    expect(deliveries).toEqual([{ kind: "notice", sessionName: "main-t-1", attemptId: "attempt-task-resume" }]);
  });

  it("resumes only the newest interrupted turn of a session", async () => {
    createLiveBoot();
    createBoot("boot-dead");
    createAttempt({ attemptId: "attempt-old", bootEpoch: "boot-dead", startedAt: NOW - 140_000 });
    createAttempt({ attemptId: "attempt-new", bootEpoch: "boot-dead", startedAt: NOW - 135_000 });
    const { deps, deliveries } = harness();

    await recover(deps);

    expect(deliveries.map((delivery) => delivery.attemptId)).toEqual(["attempt-new"]);
    expect(getRuntimeTurnAttempt("attempt-old")?.recoveryStatus).toBe("ignore_stale");
  });

  it("leaves a session alone when it already started a turn after the interrupted one", async () => {
    createLiveBoot();
    createBoot("boot-dead");
    createAttempt({ attemptId: "attempt-dead", bootEpoch: "boot-dead", startedAt: NOW - 135_000 });
    createAttempt({ attemptId: "attempt-live", bootEpoch: "boot-live", startedAt: NOW - 1_000 });
    const { deps, deliveries } = harness();

    const outcome = await recover(deps);

    expect(deliveries).toEqual([]);
    expect(outcome.skipped).toEqual([expect.objectContaining({ attemptId: "attempt-dead", reason: "superseded" })]);
    expect(getRuntimeTurnAttempt("attempt-live")?.recoveryClaimId).toBeNull();
  });

  it("does not touch a previous boot still inside its lease, and reports what waits for its expiry", async () => {
    createLiveBoot();
    const leased = createBoot("boot-leased", { lastHeartbeatAt: NOW - 5_000 });
    createAttempt({ attemptId: "attempt-1", bootEpoch: "boot-leased", startedAt: NOW - 10_000 });
    const { deps, deliveries } = harness();

    const outcome = await recover(deps);

    expect(deliveries).toEqual([]);
    expect(outcome.retryAt).toBe(leased.leaseExpiresAt);
    expect(outcome.pending).toEqual(["main-t-1"]);
    expect(outcome.pendingSessionKeys).toEqual(["agent:main:main:thread:1"]);
    expect(getRuntimeBootEpoch("boot-leased")?.status).toBe("active");
    expect(getRuntimeTurnAttempt("attempt-1")?.recoveryClaimId).toBeNull();
    expect(hasOrphanedRestartTurns({ currentBootEpoch: "boot-live", windowMs: WINDOW_MS }, deps)).toBe(true);
  });

  it("picks up unclaimed turns of a boot an earlier pass abandoned before it died", async () => {
    createLiveBoot();
    const dead = createBoot("boot-dead");
    createAttempt({ attemptId: "attempt-1", bootEpoch: "boot-dead" });
    markRuntimeBootEpochAbandoned({
      bootEpoch: "boot-dead",
      abandonedAt: NOW - 1_000,
      reason: "earlier pass",
      expectedLastHeartbeatAt: dead.lastHeartbeatAt,
      expectedLeaseExpiresAt: dead.leaseExpiresAt,
    });
    const { deps, deliveries } = harness();

    await recover(deps);

    expect(deliveries.map((delivery) => delivery.attemptId)).toEqual(["attempt-1"]);
  });

  it("ignores boots that died outside the resume window", async () => {
    createLiveBoot();
    createBoot("boot-ancient", { lastHeartbeatAt: NOW - WINDOW_MS - 1 });
    createAttempt({ attemptId: "attempt-1", bootEpoch: "boot-ancient", startedAt: NOW - WINDOW_MS - 10_000 });
    const { deps, deliveries } = harness();

    await recover(deps);

    expect(deliveries).toEqual([]);
    expect(getRuntimeBootEpoch("boot-ancient")?.status).toBe("active");
    expect(hasOrphanedRestartTurns({ currentBootEpoch: "boot-live", windowMs: WINDOW_MS }, deps)).toBe(false);
  });

  it("claims without resuming scheduled and background origins, missing sessions and sessions already handled", async () => {
    createLiveBoot();
    createBoot("boot-dead");
    createAttempt({ attemptId: "attempt-observer", bootEpoch: "boot-dead", sessionKey: "obs", originKind: "observer" });
    createAttempt({ attemptId: "attempt-cron", bootEpoch: "boot-dead", sessionKey: "cron", originKind: "cron" });
    createAttempt({ attemptId: "attempt-gone", bootEpoch: "boot-dead", sessionKey: "gone" });
    createAttempt({ attemptId: "attempt-snap", bootEpoch: "boot-dead", sessionKey: "snap" });
    const { deps, deliveries } = harness({ missingSessions: ["gone"], delivered: ["snap"] });

    const outcome = await recover(deps);

    expect(deliveries).toEqual([]);
    expect(Object.fromEntries(outcome.skipped.map((entry) => [entry.attemptId, entry.reason]))).toEqual({
      "attempt-observer": "origin_observer",
      "attempt-cron": "origin_scheduled",
      "attempt-gone": "session_missing",
      "attempt-snap": "restart_event_delivered",
    });
    expect(getRuntimeTurnAttempt("attempt-cron")?.recoveryStatus).toBe("defer_next_schedule");
    for (const attemptId of ["attempt-observer", "attempt-gone", "attempt-snap"]) {
      expect(getRuntimeTurnAttempt(attemptId)?.recoveryClaimId).not.toBeNull();
    }
  });

  it("records a failed publish on the claim and does not retry it on the next pass", async () => {
    createLiveBoot();
    createBoot("boot-dead");
    createAttempt({ attemptId: "attempt-1", bootEpoch: "boot-dead" });

    const failed = await recover(harness({ publishFails: true }).deps);
    const retry = harness();
    await recover(retry.deps);

    expect(failed.skipped).toEqual([expect.objectContaining({ attemptId: "attempt-1", reason: "publish_failed" })]);
    expect(getRuntimeTurnAttempt("attempt-1")?.recoveryStatus).toBe("action_failed");
    expect(retry.deliveries).toEqual([]);
  });

  it("only notifies an attempt recorded without its authority envelope (fails closed)", async () => {
    createLiveBoot();
    createBoot("boot-dead");
    createAttempt({ attemptId: "attempt-legacy", bootEpoch: "boot-dead", legacy: true });
    const { deps, deliveries } = harness();

    const outcome = await recover(deps);

    expect(outcome.resumed).toEqual([]);
    expect(deliveries).toEqual([{ kind: "notice", sessionName: "main-t-1", attemptId: "attempt-legacy" }]);
    const [run] = listRuntimeRecoveryRuns();
    expect(listRuntimeRecoveryCandidates(run!.recoveryRunId)).toEqual([
      expect.objectContaining({ decision: "reconcile_interrupted", reasonCode: "authority_missing" }),
    ]);
  });

  it("only notifies a relay turn whose recorded envelope lost its relay origin", async () => {
    createLiveBoot();
    createBoot("boot-dead");
    createAttempt({
      attemptId: "attempt-relay",
      bootEpoch: "boot-dead",
      turnProvenance: { origin: "agent", reason: "prompt._turnOrigin:session-relay:execute" },
    });
    const { deps, deliveries } = harness();

    await recover(deps);

    expect(deliveries).toEqual([{ kind: "notice", sessionName: "main-t-1", attemptId: "attempt-relay" }]);
    const [run] = listRuntimeRecoveryRuns();
    expect(listRuntimeRecoveryCandidates(run!.recoveryRunId)).toEqual([
      expect.objectContaining({ reasonCode: "authority_unreadable" }),
    ]);
  });

  it("resumes a relay turn whose envelope recorded its relay origin", async () => {
    createLiveBoot();
    createBoot("boot-dead");
    createAttempt({
      attemptId: "attempt-relay",
      bootEpoch: "boot-dead",
      turnProvenance: { origin: "agent", reason: "prompt._turnOrigin:session-relay:execute" },
      metadata: {
        [RESTART_TURN_AUTHORITY_METADATA_KEY]: {
          v: 1,
          _turnOrigin: {
            protocol: "ravi.runtime.turn-origin",
            schemaVersion: 1,
            producer: "session-relay",
            action: "execute",
            principal: { type: "agent", id: "main" },
            callerContextId: "ctx_caller",
          },
        },
      },
    });
    const { deps, deliveries } = harness();

    await recover(deps);

    expect(deliveries).toEqual([{ kind: "resume", sessionName: "main-t-1", attemptId: "attempt-relay" }]);
  });

  it("lists as pending only the waiting turns the deferred pass would resume", async () => {
    createLiveBoot();
    createBoot("boot-leased", { lastHeartbeatAt: NOW - 5_000 });
    createAttempt({ attemptId: "attempt-thread", bootEpoch: "boot-leased", startedAt: NOW - 10_000 });
    createAttempt({
      attemptId: "attempt-cron",
      bootEpoch: "boot-leased",
      sessionKey: "agent:main:cron",
      sessionName: "cron-session",
      originKind: "cron",
      startedAt: NOW - 10_000,
    });
    const { deps } = harness();

    const outcome = await recover(deps);

    expect(outcome.pendingSessionKeys).toEqual(["agent:main:main:thread:1"]);
    expect(outcome.pending).toEqual(["main-t-1"]);
  });

  it("still reports what it did when the recovery run cannot be closed", async () => {
    createLiveBoot();
    createBoot("boot-dead");
    createBoot("boot-leased", { lastHeartbeatAt: NOW - 5_000 });
    createAttempt({ attemptId: "attempt-1", bootEpoch: "boot-dead" });
    createAttempt({
      attemptId: "attempt-2",
      bootEpoch: "boot-leased",
      sessionKey: "agent:main:main:thread:2",
      sessionName: "main-t-2",
      startedAt: NOW - 10_000,
    });
    const { deps } = harness();
    deps.completeRecoveryRun = () => {
      throw new Error("run cannot close");
    };

    const outcome = await recover(deps);

    expect(outcome.resumed).toEqual(["main-t-1"]);
    expect(outcome.retryAt).not.toBeNull();
  });

  it("never sweeps its own boot, even when that boot's lease ran out", async () => {
    createBoot("boot-live", { lastHeartbeatAt: NOW - 130_000 });
    createAttempt({ attemptId: "attempt-own", bootEpoch: "boot-live" });
    const { deps, deliveries } = harness();

    await recover(deps);

    expect(deliveries).toEqual([]);
    expect(getRuntimeBootEpoch("boot-live")?.status).toBe("active");
    expect(getRuntimeTurnAttempt("attempt-own")?.recoveryClaimId).toBeNull();
  });

  it("leaves a boot alone when fencing it fails (its owner renewed after the listing)", async () => {
    createLiveBoot();
    createBoot("boot-dead");
    createAttempt({ attemptId: "attempt-1", bootEpoch: "boot-dead" });
    const { deps, deliveries } = harness();
    deps.abandonBootEpoch = () => false;

    const outcome = await recover(deps);

    expect(deliveries).toEqual([]);
    expect(outcome.recoveryRunId).toBeNull();
    expect(getRuntimeTurnAttempt("attempt-1")?.recoveryClaimId).toBeNull();
  });

  it("claims without resuming the turn of a task that is no longer active", async () => {
    createLiveBoot();
    createBoot("boot-dead");
    createAttempt({
      attemptId: "attempt-task",
      bootEpoch: "boot-dead",
      originKind: "task",
      taskBarrierTaskId: "task-done",
    });
    const { deps, deliveries } = harness();
    deps.isTerminalTaskSession = (_sessionName, taskId) => taskId === "task-done";

    const outcome = await recover(deps);

    expect(deliveries).toEqual([]);
    expect(outcome.skipped).toEqual([expect.objectContaining({ attemptId: "attempt-task", reason: "terminal_task" })]);
  });

  it("does nothing without its own boot epoch", async () => {
    createBoot("boot-dead");
    createAttempt({ attemptId: "attempt-1", bootEpoch: "boot-dead" });
    const { deps, deliveries } = harness();

    const outcome = await recover(deps, null);

    expect(outcome.resumed).toEqual([]);
    expect(deliveries).toEqual([]);
    expect(getRuntimeBootEpoch("boot-dead")?.status).toBe("active");
  });
});

describe("judging an attempt a graceful restart interrupted", () => {
  const reader = { hasLaterAttempt: hasLaterRuntimeTurnAttempt };

  it("resumes an aborted conversational turn and refuses a finished one", () => {
    createLiveBoot();
    createAttempt({ attemptId: "attempt-1", bootEpoch: "boot-live", startedAt: NOW - 1_000 });
    const attempt = getRuntimeTurnAttempt("attempt-1")!;

    expect(judgeRestartInterruptedAttempt({ ...attempt, status: "aborted" }, reader).kind).toBe("resume");
    expect(judgeRestartInterruptedAttempt({ ...attempt, status: "complete" }, reader)).toMatchObject({
      kind: "skip",
      reason: "turn_completed",
    });
    expect(judgeRestartInterruptedAttempt(null, reader)).toMatchObject({ kind: "skip", reason: "attempt_missing" });
  });
});

describe("which session an orphaned attempt resumes in", () => {
  const attempt = { sessionKey: "agent:x:main", agentId: "x" };

  it("resolves the session by its key", () => {
    const lookup = {
      getSessionByKey: (key: string) => (key === "agent:x:main" ? { name: "x-main", agentId: "x" } : null),
    };
    expect(resolveOrphanedTurnSessionName(attempt, lookup)).toBe("x-main");
  });

  it("never falls back to a session that reuses the name after the original was deleted", () => {
    const sessionsByName = new Map([["x-main", { name: "x-main", agentId: "y" }]]);
    const lookup = {
      getSessionByKey: () => null,
      getSessionByName: (name: string) => sessionsByName.get(name) ?? null,
    };
    expect(resolveOrphanedTurnSessionName(attempt, lookup)).toBeNull();
  });

  it("refuses a key now owned by another agent", () => {
    const lookup = { getSessionByKey: () => ({ name: "x-main", agentId: "y" }) };
    expect(resolveOrphanedTurnSessionName(attempt, lookup)).toBeNull();
  });
});

describe("the sessions table decides where an orphaned attempt resumes", () => {
  it("does not resume in a new session of the same agent that took the deleted session's name", () => {
    const attempt = { sessionKey: "agent:x:main:thread:1", agentId: "x", sessionName: "reused-name" };
    getOrCreateSession("agent:x:main:thread:1", "x", stateDir!, { name: "reused-name" });
    deleteSession("agent:x:main:thread:1");
    getOrCreateSession("agent:x:main:thread:2", "x", stateDir!, { name: "reused-name" });

    expect(resolveOrphanedTurnSessionNameFromStore(attempt)).toBeNull();
  });

  it("does not resume in another agent's session that took the deleted session's name", () => {
    getOrCreateSession("agent:x:main:thread:1", "x", stateDir!, { name: "reused-name" });
    const attempt = { sessionKey: "agent:x:main:thread:1", agentId: "x", sessionName: "reused-name" };
    expect(resolveOrphanedTurnSessionNameFromStore(attempt)).toBe("reused-name");

    deleteSession("agent:x:main:thread:1");
    getOrCreateSession("agent:y:main:thread:9", "y", stateDir!, { name: "reused-name" });

    expect(resolveOrphanedTurnSessionNameFromStore(attempt)).toBeNull();
  });
});
