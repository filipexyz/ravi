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
  providerStatePublishIntentIsResolved,
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
    const first = getOrCreateSession("session-a", "agent-a", "/workspace/project");
    const second = getOrCreateSession("session-b", "agent-a", "/workspace/project");
    establishAttempt(first.sessionKey, "attempt-a", "boot-a");
    establishAttempt(second.sessionKey, "attempt-b", "boot-b");

    const lifecycleA = createProviderStateLifecycle({
      provider: "test-provider",
      sessionKey: first.sessionKey,
      admittedEpoch: first.lifecycleGeneration!,
      currentAttempt: () => ({ attemptId: "attempt-a", bootEpoch: "boot-a" }),
      now: () => 200,
    });
    const lifecycleB = createProviderStateLifecycle({
      provider: "test-provider",
      sessionKey: second.sessionKey,
      admittedEpoch: second.lifecycleGeneration!,
      currentAttempt: () => ({ attemptId: "attempt-b", bootEpoch: "boot-b" }),
      now: () => 201,
    });

    lifecycleA.publishPreparedState({
      reservationId: "reservation-a",
      locator: locator("00000000-0000-4000-8000-00000000000a", "/private/a/revision-1.json"),
      publish: () => undefined,
    });
    lifecycleB.publishPreparedState({
      reservationId: "reservation-b",
      locator: locator("00000000-0000-4000-8000-00000000000b", "/private/b/revision-1.json"),
      publish: () => undefined,
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
    const session = getOrCreateSession("session-order", "agent-a", "/workspace/project");
    establishAttempt(session.sessionKey, "attempt-order", "boot-order");
    const lifecycle = createProviderStateLifecycle({
      provider: "test-provider",
      sessionKey: session.sessionKey,
      admittedEpoch: session.lifecycleGeneration!,
      currentAttempt: () => ({ attemptId: "attempt-order", bootEpoch: "boot-order" }),
      now: () => 200,
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
    });

    expect(observed).toEqual(["prepared"]);
    expect(result.reservationId).toBe("reservation-order");
    expect(
      getDb().prepare("SELECT status FROM provider_state_cleanup_tasks WHERE id = ?").get("reservation-order"),
    ).toEqual({ status: "published" });
  });

  it("rolls back the reservation when publication throws or returns a Promise", () => {
    const session = getOrCreateSession("session-rollback", "agent-a", "/workspace/project");
    establishAttempt(session.sessionKey, "attempt-rollback", "boot-rollback");
    const lifecycle = createProviderStateLifecycle({
      provider: "test-provider",
      sessionKey: session.sessionKey,
      admittedEpoch: session.lifecycleGeneration!,
      currentAttempt: () => ({ attemptId: "attempt-rollback", bootEpoch: "boot-rollback" }),
      now: () => 200,
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
    const session = getOrCreateSession("session-stale", "agent-a", "/workspace/project");
    establishAttempt(session.sessionKey, "attempt-stale", "boot-stale");
    const lifecycle = createProviderStateLifecycle({
      provider: "test-provider",
      sessionKey: session.sessionKey,
      admittedEpoch: session.lifecycleGeneration!,
      currentAttempt: () => ({ attemptId: "attempt-stale", bootEpoch: "boot-stale" }),
      now: () => 200,
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

  it("uses the host clock to reject expired attempt leases before provider publication", () => {
    const session = getOrCreateSession("session-expired", "agent-a", "/workspace/project");
    establishAttempt(session.sessionKey, "attempt-expired", "boot-expired");
    const lifecycle = createProviderStateLifecycle({
      provider: "test-provider",
      sessionKey: session.sessionKey,
      admittedEpoch: session.lifecycleGeneration!,
      currentAttempt: () => ({ attemptId: "attempt-expired", bootEpoch: "boot-expired" }),
      now: () => 1_000,
    });
    let published = false;

    expect(() =>
      lifecycle.publishPreparedState({
        reservationId: "reservation-expired",
        locator: locator("00000000-0000-4000-8000-000000000020", "/private/expired/revision-1.json"),
        publish: () => {
          published = true;
        },
      }),
    ).toThrow("ownership");
    expect(published).toBe(false);
    expect(getDb().prepare("SELECT id FROM provider_state_cleanup_tasks").get()).toBeNull();
  });

  it("rolls back when the synchronous callback exceeds the host deadline", () => {
    const session = getOrCreateSession("session-deadline", "agent-a", "/workspace/project");
    establishAttempt(session.sessionKey, "attempt-deadline", "boot-deadline");
    const observations = [200, 205, 211];
    const lifecycle = createProviderStateLifecycle({
      provider: "test-provider",
      sessionKey: session.sessionKey,
      admittedEpoch: session.lifecycleGeneration!,
      currentAttempt: () => ({ attemptId: "attempt-deadline", bootEpoch: "boot-deadline" }),
      now: () => observations.shift()!,
      publishDeadlineMs: 10,
    });
    let published = false;

    expect(() =>
      lifecycle.publishPreparedState({
        reservationId: "reservation-deadline",
        locator: locator("00000000-0000-4000-8000-000000000021", "/private/deadline/revision-1.json"),
        publish: () => {
          published = true;
        },
      }),
    ).toThrow("deadline");
    expect(published).toBe(true);
    expect(getDb().prepare("SELECT id FROM provider_state_cleanup_tasks").get()).toBeNull();
  });

  it("rejects a locator for another provider before invoking its callback", () => {
    const session = getOrCreateSession("session-provider-scope", "agent-a", "/workspace/project");
    establishAttempt(session.sessionKey, "attempt-provider-scope", "boot-provider-scope");
    const lifecycle = createProviderStateLifecycle({
      provider: "test-provider",
      sessionKey: session.sessionKey,
      admittedEpoch: session.lifecycleGeneration!,
      currentAttempt: () => ({ attemptId: "attempt-provider-scope", bootEpoch: "boot-provider-scope" }),
      now: () => 200,
    });
    let published = false;

    expect(() =>
      lifecycle.publishPreparedState({
        reservationId: "reservation-provider-scope",
        locator: {
          ...locator("00000000-0000-4000-8000-000000000022", "/private/provider/revision-1.json"),
          provider: "foreign-provider",
        },
        publish: () => {
          published = true;
        },
      }),
    ).toThrow("scoped lifecycle provider");
    expect(published).toBe(false);
  });
});

describe("provider state publish-intent reconciliation", () => {
  it("removes only intent decisions backed by owned state or a durable cleanup task", () => {
    expect(providerStatePublishIntentIsResolved("held_active_attempt")).toBe(false);
    expect(providerStatePublishIntentIsResolved("held_invalid_attempt")).toBe(false);
    expect(providerStatePublishIntentIsResolved("remove_owned_intent")).toBe(true);
    expect(providerStatePublishIntentIsResolved("held_existing_task")).toBe(false);
    expect(providerStatePublishIntentIsResolved("published_cleanup")).toBe(false);
  });

  it("holds an active attempt, then recreates the exact published task after attempt loss", () => {
    const session = getOrCreateSession("session-reconcile", "agent-a", "/workspace/project");
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

    const reconcile = (now: number) =>
      reconcileProviderStatePublishIntent({
        provider: "test-provider",
        intent,
        isLocatorOwned: () => false,
        now,
      });

    expect(reconcile(200)).toBe("held_active_attempt");
    expect(
      getDb().prepare("SELECT id FROM provider_state_cleanup_tasks WHERE id = ?").get(intent.taskId),
    ).toBeNull();

    terminalizeRuntimeTurnAttempt({ attemptId: "attempt-reconcile", status: "aborted", completedAt: 300 });
    expect(reconcile(301)).toBe("published_cleanup");
    expect(
      getDb()
        .prepare("SELECT status, owner_attempt_id FROM provider_state_cleanup_tasks WHERE id = ?")
        .get(intent.taskId),
    ).toEqual({ status: "published", owner_attempt_id: "attempt-reconcile" });
    expect(reconcile(302)).toBe("held_existing_task");
  });

  it("dead-letters missing attempt evidence without making it claimable", () => {
    const intent = {
      taskId: "reservation-missing-attempt",
      ownerAttemptId: "attempt-missing",
      locatorJson: serializeProviderStateCleanupLocator(
        locator("00000000-0000-4000-8000-000000000023", "/private/missing/revision-1.json"),
      ),
    };

    expect(
      reconcileProviderStatePublishIntent({
        provider: "test-provider",
        intent,
        isLocatorOwned: () => false,
        now: 200,
      }),
    ).toBe("held_invalid_attempt");
    expect(
      getDb()
        .prepare("SELECT id, status, last_error_code FROM provider_state_cleanup_tasks")
        .get(),
    ).toEqual({
      id: intent.taskId,
      status: "dead",
      last_error_code: "state_missing",
    });
    expect(
      reconcileProviderStatePublishIntent({
        provider: "test-provider",
        intent,
        isLocatorOwned: () => false,
        now: 201,
      }),
    ).toBe("held_existing_task");
  });

  it("keeps canonical durable evidence when an invalid intent reuses its idempotency key", () => {
    const canonicalLocator = locator(
      "00000000-0000-4000-8000-000000000025",
      "/private/idempotency-collision/revision-1.json",
    );
    const locatorJson = serializeProviderStateCleanupLocator(canonicalLocator);
    const session = getOrCreateSession("session-idempotency-collision", "agent-a", "/workspace/project");
    establishAttempt(session.sessionKey, "attempt-valid-evidence", "boot-valid-evidence");
    terminalizeRuntimeTurnAttempt({
      attemptId: "attempt-valid-evidence",
      status: "aborted",
      completedAt: 200,
    });
    expect(
      reconcileProviderStatePublishIntent({
        provider: "test-provider",
        intent: {
          taskId: "reservation-valid-evidence",
          ownerAttemptId: "attempt-valid-evidence",
          locatorJson,
        },
        isLocatorOwned: () => false,
        now: 201,
      }),
    ).toBe("published_cleanup");

    expect(
      reconcileProviderStatePublishIntent({
        provider: "test-provider",
        intent: {
          taskId: "reservation-invalid-collision",
          ownerAttemptId: "attempt-missing-collision",
          locatorJson,
        },
        isLocatorOwned: () => false,
        now: 202,
      }),
    ).toBe("held_existing_task");
    expect(
      getDb()
        .prepare(
          `SELECT id, status, owner_attempt_id, owner_session_key, owner_boot_epoch, last_error_code
           FROM provider_state_cleanup_tasks`,
        )
        .all(),
    ).toEqual([
      {
        id: "reservation-valid-evidence",
        status: "published",
        owner_attempt_id: "attempt-valid-evidence",
        owner_session_key: session.sessionKey,
        owner_boot_epoch: "boot-valid-evidence",
        last_error_code: null,
      },
    ]);
  });

  it("rejects an intent locator outside the registered provider scope", () => {
    const intent = {
      taskId: "reservation-foreign-provider",
      ownerAttemptId: "attempt-foreign-provider",
      locatorJson: serializeProviderStateCleanupLocator({
        ...locator("00000000-0000-4000-8000-000000000024", "/private/foreign/revision-1.json"),
        provider: "foreign-provider",
      }),
    };
    let ownershipChecked = false;

    expect(() =>
      reconcileProviderStatePublishIntent({
        provider: "test-provider",
        intent,
        isLocatorOwned: () => {
          ownershipChecked = true;
          return false;
        },
        now: 200,
      }),
    ).toThrow("scoped reconciler provider");
    expect(ownershipChecked).toBe(false);
  });
});
