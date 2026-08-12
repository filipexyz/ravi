import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getDb } from "../router/router-db.js";
import { getOrCreateSession } from "../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  createRuntimeBootEpoch,
  createRuntimeTurnAttempt,
  terminalizeRuntimeTurnAttempt,
} from "./crash-recovery-store.js";
import { serializeProviderStateCleanupLocator } from "./provider-state-cleanup-store.js";
import {
  createProviderStateLifecycle,
  reconcileProviderStatePublishIntent,
} from "./provider-state-lifecycle.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-provider-lifecycle-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function locator(sessionId: string, sessionFile: string) {
  return {
    schemaVersion: 1 as const,
    provider: "test-provider",
    model: "test-model",
    sessionId,
    revision: 1,
    cwd: "/workspace/project",
    workspaceIdentity: { realpath: "/workspace/project", device: "1", inode: "2" },
    sessionFile,
    lastCommittedTurnId: "turn-1",
  };
}

function establishAttempt(sessionKey: string, attemptId: string, bootEpoch: string): void {
  createRuntimeBootEpoch({
    bootEpoch,
    instanceId: "test-instance",
    pid: 123,
    startedAt: 100,
    lastHeartbeatAt: 100,
    leaseExpiresAt: 10_000,
  });
  createRuntimeTurnAttempt({
    attemptId,
    turnId: `turn-${attemptId}`,
    runId: `run-${attemptId}`,
    sessionKey,
    agentId: "agent-a",
    provider: "test-provider",
    model: "test-model",
    bootEpoch,
    startedAt: 100,
    lastHeartbeatAt: 100,
    leaseExpiresAt: 1_000,
    requestBlobSha256: "request-sha",
    originKind: "human",
    deliveryBarrier: "after_response",
  });
}

describe("request-scoped provider state lifecycle", () => {
  it("keeps two session scopes isolated without process-global owner state", () => {
    const first = getOrCreateSession("session-a", { agentId: "agent-a" });
    const second = getOrCreateSession("session-b", { agentId: "agent-a" });
    establishAttempt(first.sessionKey, "attempt-a", "boot-a");
    establishAttempt(second.sessionKey, "attempt-b", "boot-b");

    const lifecycleA = createProviderStateLifecycle({
      provider: "test-provider",
      sessionKey: first.sessionKey,
      admittedEpoch: first.lifecycleGeneration,
      currentAttempt: () => ({ attemptId: "attempt-a", bootEpoch: "boot-a" }),
    });
    const lifecycleB = createProviderStateLifecycle({
      provider: "test-provider",
      sessionKey: second.sessionKey,
      admittedEpoch: second.lifecycleGeneration,
      currentAttempt: () => ({ attemptId: "attempt-b", bootEpoch: "boot-b" }),
    });

    lifecycleA.publishPreparedState({
      reservationId: "reservation-a",
      locator: locator("00000000-0000-4000-8000-00000000000a", "/private/a/revision-1.json"),
      publish: () => undefined,
      now: 200,
    });
    lifecycleB.publishPreparedState({
      reservationId: "reservation-b",
      locator: locator("00000000-0000-4000-8000-00000000000b", "/private/b/revision-1.json"),
      publish: () => undefined,
      now: 201,
    });

    const rows = getDb()
      .prepare(
        "SELECT id, owner_session_key, owner_attempt_id FROM provider_state_cleanup_tasks ORDER BY id",
      )
      .all();
    expect(rows).toEqual([
      { id: "reservation-a", owner_session_key: first.sessionKey, owner_attempt_id: "attempt-a" },
      { id: "reservation-b", owner_session_key: second.sessionKey, owner_attempt_id: "attempt-b" },
    ]);
  });

  it("orders prepared, synchronous publication, and published inside one transaction", () => {
    const session = getOrCreateSession("session-order", { agentId: "agent-a" });
    establishAttempt(session.sessionKey, "attempt-order", "boot-order");
    const lifecycle = createProviderStateLifecycle({
      provider: "test-provider",
      sessionKey: session.sessionKey,
      admittedEpoch: session.lifecycleGeneration,
      currentAttempt: () => ({ attemptId: "attempt-order", bootEpoch: "boot-order" }),
    });
    const observed: string[] = [];

    const result = lifecycle.publishPreparedState({
      reservationId: "reservation-order",
      locator: locator("00000000-0000-4000-8000-00000000000c", "/private/c/revision-1.json"),
      publish: () => {
        const row = getDb()
          .prepare("SELECT status FROM provider_state_cleanup_tasks WHERE id = ?")
          .get("reservation-order") as { status: string };
        observed.push(row.status);
      },
      now: 200,
    });

    expect(observed).toEqual(["prepared"]);
    expect(result.reservationId).toBe("reservation-order");
    expect(
      getDb().prepare("SELECT status FROM provider_state_cleanup_tasks WHERE id = ?").get("reservation-order"),
    ).toEqual({ status: "published" });
  });

  it("rolls back the reservation when publication throws or returns a Promise", () => {
    const session = getOrCreateSession("session-rollback", { agentId: "agent-a" });
    establishAttempt(session.sessionKey, "attempt-rollback", "boot-rollback");
    const lifecycle = createProviderStateLifecycle({
      provider: "test-provider",
      sessionKey: session.sessionKey,
      admittedEpoch: session.lifecycleGeneration,
      currentAttempt: () => ({ attemptId: "attempt-rollback", bootEpoch: "boot-rollback" }),
    });

    expect(() =>
      lifecycle.publishPreparedState({
        reservationId: "reservation-throw",
        locator: locator("00000000-0000-4000-8000-00000000000d", "/private/d/revision-1.json"),
        publish: () => {
          throw new Error("publication failed");
        },
      }),
    ).toThrow("publication failed");
    expect(() =>
      lifecycle.publishPreparedState({
        reservationId: "reservation-promise",
        locator: locator("00000000-0000-4000-8000-00000000000e", "/private/e/revision-1.json"),
        publish: (() => Promise.resolve()) as unknown as () => void,
      }),
    ).toThrow("synchronous");
    expect(
      getDb().prepare("SELECT COUNT(*) AS count FROM provider_state_cleanup_tasks").get(),
    ).toEqual({ count: 0 });
  });

  it("fails closed before publication when epoch or current attempt ownership changed", () => {
    const session = getOrCreateSession("session-stale", { agentId: "agent-a" });
    establishAttempt(session.sessionKey, "attempt-stale", "boot-stale");
    const lifecycle = createProviderStateLifecycle({
      provider: "test-provider",
      sessionKey: session.sessionKey,
      admittedEpoch: session.lifecycleGeneration,
      currentAttempt: () => ({ attemptId: "attempt-stale", bootEpoch: "boot-stale" }),
    });
    getDb()
      .prepare("UPDATE sessions SET lifecycle_generation = lifecycle_generation + 1 WHERE session_key = ?")
      .run(session.sessionKey);
    let published = false;

    expect(() =>
      lifecycle.publishPreparedState({
        reservationId: "reservation-stale",
        locator: locator("00000000-0000-4000-8000-00000000000f", "/private/f/revision-1.json"),
        publish: () => {
          published = true;
        },
      }),
    ).toThrow("ownership");
    expect(published).toBe(false);
  });
});

describe("provider state publish-intent reconciliation", () => {
  it("holds an active attempt, then recreates the exact published task after attempt loss", () => {
    const session = getOrCreateSession("session-reconcile", { agentId: "agent-a" });
    establishAttempt(session.sessionKey, "attempt-reconcile", "boot-reconcile");
    const canonicalLocator = locator(
      "00000000-0000-4000-8000-000000000010",
      "/private/reconcile/revision-1.json",
    );
    const intent = {
      taskId: "reservation-reconcile",
      ownerAttemptId: "attempt-reconcile",
      locatorJson: serializeProviderStateCleanupLocator(canonicalLocator),
    };

    expect(reconcileProviderStatePublishIntent({ intent, now: 200 })).toBe("held_active_attempt");
    expect(
      getDb().prepare("SELECT id FROM provider_state_cleanup_tasks WHERE id = ?").get(intent.taskId),
    ).toBeNull();

    terminalizeRuntimeTurnAttempt({ attemptId: "attempt-reconcile", status: "aborted", completedAt: 300 });
    expect(reconcileProviderStatePublishIntent({ intent, now: 301 })).toBe("published_cleanup");
    expect(
      getDb()
        .prepare("SELECT status, owner_attempt_id FROM provider_state_cleanup_tasks WHERE id = ?")
        .get(intent.taskId),
    ).toEqual({ status: "published", owner_attempt_id: "attempt-reconcile" });
    expect(reconcileProviderStatePublishIntent({ intent, now: 302 })).toBe("held_existing_task");
  });
});
