import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { executeWrite } from "../db/write-retry.js";
import { getDb } from "../router/router-db.js";
import { getOrCreateSession, getSession } from "../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import * as providerStateCleanupStore from "./provider-state-cleanup-store.js";
import {
  createRuntimeBootEpoch,
  createRuntimeTurnAttempt,
  terminalizeRuntimeTurnAttempt,
} from "./crash-recovery-store.js";
import {
  claimProviderStateCleanupTasks,
  completeProviderStateCleanupTask,
  createProviderStateCleanupIdempotencyKey,
  enqueuePreparedProviderStateCleanupTask,
  enqueuePreparedProviderStateCleanupTaskInTransaction,
  enqueuePublishedProviderStateCleanupTask,
  failProviderStateCleanupTask,
  mutateSessionAndEnqueueProviderStateCleanup,
  parseProviderStateCleanupLocator,
  publishPreparedProviderStateCleanupTaskInTransaction,
  serializeProviderStateCleanupLocator,
} from "./provider-state-cleanup-store.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-provider-state-cleanup-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function locator(revision = 1, suffix = "a") {
  return {
    schemaVersion: 1 as const,
    provider: "kimi-code",
    model: "k3",
    sessionId: `00000000-0000-4000-8000-00000000000${suffix}`,
    revision,
    cwd: "/workspace/project",
    workspaceIdentity: { realpath: "/workspace/project", device: "1", inode: "2" },
    sessionFile: `/private/kimi/${suffix}/revision-${revision}.json`,
    lastCommittedTurnId: `turn-${revision}`,
  };
}

function publishTask(id: string): void {
  getDb()
    .prepare("UPDATE provider_state_cleanup_tasks SET status = 'published' WHERE id = ? AND status = 'prepared'")
    .run(id);
}

function createAttempt(input: {
  attemptId: string;
  sessionKey: string;
  bootEpoch?: string;
  provider?: string;
  leaseExpiresAt?: number;
}): void {
  const bootEpoch = input.bootEpoch ?? `boot-${input.attemptId}`;
  createRuntimeBootEpoch({
    bootEpoch,
    instanceId: "local",
    pid: 1234,
    startedAt: 100,
    lastHeartbeatAt: 100,
    leaseExpiresAt: 10_000,
  });
  createRuntimeTurnAttempt({
    attemptId: input.attemptId,
    turnId: `turn-${input.attemptId}`,
    runId: `run-${input.attemptId}`,
    sessionKey: input.sessionKey,
    agentId: "agent-a",
    provider: input.provider ?? "kimi-code",
    model: "k3",
    bootEpoch,
    startedAt: 100,
    lastHeartbeatAt: 100,
    leaseExpiresAt: input.leaseExpiresAt ?? 1_000,
    requestBlobSha256: "request-sha",
    originKind: "human",
    deliveryBarrier: "after_response",
  });
}

describe("provider state cleanup canonical locator", () => {
  it("projects only allowlisted fields, parses exact canonical JSON, and derives stable task keys", () => {
    const source = {
      ...locator(),
      runtimeCredential: { credentialId: "secret-profile" },
      skillVisibility: { hidden: ["private-skill"] },
      hostMetadata: { authorization: "Bearer secret" },
    };
    const canonical = serializeProviderStateCleanupLocator(source);

    expect(canonical).toBe(
      '{"schemaVersion":1,"provider":"kimi-code","model":"k3","sessionId":"00000000-0000-4000-8000-00000000000a","revision":1,"cwd":"/workspace/project","workspaceIdentity":{"realpath":"/workspace/project","device":"1","inode":"2"},"sessionFile":"/private/kimi/a/revision-1.json","lastCommittedTurnId":"turn-1"}',
    );
    expect(canonical).not.toContain("secret");
    expect(parseProviderStateCleanupLocator(canonical)).toEqual(locator());
    expect(() => parseProviderStateCleanupLocator(canonical.replace("{", '{"unknown":true,'))).toThrow();

    const first = createProviderStateCleanupIdempotencyKey("delete_state", canonical, null);
    const second = createProviderStateCleanupIdempotencyKey("delete_state", canonical, null);
    const retirement = createProviderStateCleanupIdempotencyKey("retire_revision", canonical, canonical);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
    expect(retirement).not.toBe(first);
  });

  it("rejects malformed primitives and canonical payloads above 16 KiB", () => {
    expect(() => serializeProviderStateCleanupLocator({ ...locator(), revision: 0 })).toThrow();
    expect(() => serializeProviderStateCleanupLocator({ ...locator(), model: "x".repeat(17 * 1024) })).toThrow(
      "16 KiB",
    );
    expect(() => parseProviderStateCleanupLocator(JSON.stringify({ ...locator(), revision: "1" }))).toThrow();
  });
});

describe("provider state cleanup durable store", () => {
  it("enqueues prepared and published tasks idempotently", () => {
    const owner = { attemptId: "attempt-a", sessionKey: "session-a", bootEpoch: "boot-a" };
    const prepared = enqueuePreparedProviderStateCleanupTask({ locator: locator(), owner, now: 100 });
    const duplicate = enqueuePreparedProviderStateCleanupTask({ locator: locator(), owner, now: 200 });
    const successor = locator(2, "a");
    const retirement = enqueuePublishedProviderStateCleanupTask({
      operation: "retire_revision",
      locator: locator(),
      successorLocator: successor,
      now: 300,
    });

    expect(duplicate.id).toBe(prepared.id);
    expect(duplicate.createdAt).toBe(100);
    expect(prepared).toMatchObject({
      status: "prepared",
      operation: "provisional_exact",
      ownerAttemptId: "attempt-a",
      ownerSessionKey: "session-a",
      ownerBootEpoch: "boot-a",
    });
    expect(retirement).toMatchObject({
      status: "published",
      operation: "retire_revision",
      successorLocatorJson: serializeProviderStateCleanupLocator(successor),
    });
    expect(
      (getDb().prepare("SELECT COUNT(*) AS count FROM provider_state_cleanup_tasks").get() as { count: number }).count,
    ).toBe(2);
  });

  it("rejects a different caller-supplied reservation id for the same provisional locator", () => {
    const owner = { attemptId: "attempt-a", sessionKey: "session-a", bootEpoch: "boot-a" };
    const first = enqueuePreparedProviderStateCleanupTask({
      id: "reservation-a",
      locator: locator(),
      owner,
      now: 100,
    });

    expect(() =>
      enqueuePreparedProviderStateCleanupTask({
        id: "reservation-b",
        locator: locator(),
        owner,
        now: 200,
      }),
    ).toThrow("different immutable task data");
    expect(first.id).toBe("reservation-a");
    expect(
      getDb()
        .prepare("SELECT id FROM provider_state_cleanup_tasks WHERE idempotency_key = ?")
        .get(first.idempotencyKey),
    ).toEqual({ id: "reservation-a" });
  });

  it("exposes only transaction-scoped promotion and composes callback work with enqueue and promotion", () => {
    expect("publishPreparedProviderStateCleanupTask" in providerStateCleanupStore).toBe(false);
    const owner = { attemptId: "attempt-a", sessionKey: "session-a", bootEpoch: "boot-a" };
    const input = { id: "reservation-composable", locator: locator(), owner, now: 100 };
    getDb().exec("CREATE TEMP TABLE cleanup_publish_markers (id TEXT PRIMARY KEY)");

    const published = executeWrite(getDb(), (database) => {
      expect(enqueuePreparedProviderStateCleanupTaskInTransaction(database, input)).toMatchObject({
        id: input.id,
        status: "prepared",
      });
      expect(
        publishPreparedProviderStateCleanupTaskInTransaction(database, {
          ...input,
          locator: locator(2, "a"),
          now: 200,
        }),
      ).toBeNull();
      expect(
        publishPreparedProviderStateCleanupTaskInTransaction(database, {
          ...input,
          owner: { ...owner, sessionKey: "wrong-session" },
          now: 200,
        }),
      ).toBeNull();
      database.prepare("INSERT INTO cleanup_publish_markers (id) VALUES (?)").run(input.id);
      return publishPreparedProviderStateCleanupTaskInTransaction(database, { ...input, now: 300 });
    });
    expect(published).toMatchObject({
      id: input.id,
      status: "published",
    });
    expect(getDb().prepare("SELECT id FROM cleanup_publish_markers WHERE id = ?").get(input.id)).toEqual({
      id: input.id,
    });

    const rollbackInput = { ...input, id: "reservation-rollback", locator: locator(2, "b") };
    expect(() =>
      executeWrite(getDb(), (database) => {
        enqueuePreparedProviderStateCleanupTaskInTransaction(database, rollbackInput);
        database.prepare("INSERT INTO cleanup_publish_markers (id) VALUES (?)").run(rollbackInput.id);
        expect(publishPreparedProviderStateCleanupTaskInTransaction(database, rollbackInput)).toMatchObject({
          id: rollbackInput.id,
          status: "published",
        });
        throw new Error("rollback composed publish");
      }),
    ).toThrow("rollback composed publish");
    expect(
      getDb().prepare("SELECT id FROM provider_state_cleanup_tasks WHERE id = ?").get(rollbackInput.id),
    ).toBeNull();
    expect(getDb().prepare("SELECT id FROM cleanup_publish_markers WHERE id = ?").get(rollbackInput.id)).toBeNull();
  });

  it("commits a session CAS and cleanup task together, creates nothing on loss, and rolls back on enqueue error", () => {
    const lost = getOrCreateSession("session:lost", "agent-a", "/workspace/project");
    const loss = mutateSessionAndEnqueueProviderStateCleanup(
      { operation: "delete_state", locator: locator(1, "a"), now: 100 },
      (database) => {
        database
          .prepare("UPDATE sessions SET display_name = ? WHERE session_key = ?")
          .run("must-roll-back", lost.sessionKey);
        return false;
      },
    );
    expect(loss.won).toBe(false);
    expect(getSession(lost.sessionKey)?.displayName).toBeUndefined();
    expect(
      (getDb().prepare("SELECT COUNT(*) AS count FROM provider_state_cleanup_tasks").get() as { count: number }).count,
    ).toBe(0);

    const winner = getOrCreateSession("session:winner", "agent-a", "/workspace/project");
    const win = mutateSessionAndEnqueueProviderStateCleanup(
      { operation: "delete_state", locator: locator(1, "b"), now: 200 },
      (database) =>
        database
          .prepare("DELETE FROM sessions WHERE session_key = ? AND lifecycle_generation = ?")
          .run(winner.sessionKey, winner.lifecycleGeneration!).changes === 1,
    );
    expect(win.won).toBe(true);
    expect(getSession(winner.sessionKey)).toBeNull();

    enqueuePublishedProviderStateCleanupTask({
      id: "fixed-task-id",
      operation: "delete_state",
      locator: locator(1, "c"),
      now: 300,
    });
    const rollback = getOrCreateSession("session:rollback", "agent-a", "/workspace/project");
    expect(() =>
      mutateSessionAndEnqueueProviderStateCleanup(
        { id: "fixed-task-id", operation: "delete_state", locator: locator(1, "d"), now: 400 },
        (database) =>
          database
            .prepare("DELETE FROM sessions WHERE session_key = ? AND lifecycle_generation = ?")
            .run(rollback.sessionKey, rollback.lifecycleGeneration!).changes === 1,
      ),
    ).toThrow();
    expect(getSession(rollback.sessionKey)).not.toBeNull();
  });

  it("holds prepared and active-attempt provisional tasks, claims terminal and expired attempts, and dead-letters missing owners", () => {
    createAttempt({ attemptId: "attempt-active", sessionKey: "session-active" });
    const active = enqueuePreparedProviderStateCleanupTask({
      locator: locator(1, "a"),
      owner: { attemptId: "attempt-active", sessionKey: "session-active", bootEpoch: "boot-attempt-active" },
      now: 100,
    });
    expect(claimProviderStateCleanupTasks({ now: 500, limit: 10, leaseDurationMs: 100 })).toEqual([]);
    publishTask(active.id);
    expect(claimProviderStateCleanupTasks({ now: 500, limit: 10, leaseDurationMs: 100 })).toEqual([]);
    terminalizeRuntimeTurnAttempt({ attemptId: "attempt-active", status: "complete", completedAt: 600 });
    const terminalClaim = claimProviderStateCleanupTasks({ now: 700, limit: 10, leaseDurationMs: 100 });
    expect(terminalClaim).toEqual([expect.objectContaining({ id: active.id, status: "leased", attemptCount: 1 })]);
    expect(completeProviderStateCleanupTask({ id: active.id, leaseId: terminalClaim[0]!.leaseId!, now: 701 })).toBe(
      true,
    );

    createAttempt({ attemptId: "attempt-expired", sessionKey: "session-expired", leaseExpiresAt: 1_000 });
    const expired = enqueuePreparedProviderStateCleanupTask({
      locator: locator(1, "b"),
      owner: { attemptId: "attempt-expired", sessionKey: "session-expired", bootEpoch: "boot-attempt-expired" },
      now: 100,
    });
    publishTask(expired.id);
    const expiredClaim = claimProviderStateCleanupTasks({ now: 1_000, limit: 10, leaseDurationMs: 100 });
    expect(expiredClaim).toEqual([expect.objectContaining({ id: expired.id, status: "leased", attemptCount: 1 })]);
    expect(completeProviderStateCleanupTask({ id: expired.id, leaseId: expiredClaim[0]!.leaseId!, now: 1_001 })).toBe(
      true,
    );

    const missing = enqueuePreparedProviderStateCleanupTask({
      locator: locator(1, "c"),
      owner: { attemptId: "attempt-missing", sessionKey: "session-missing", bootEpoch: "boot-missing" },
      now: 100,
    });
    publishTask(missing.id);
    expect(claimProviderStateCleanupTasks({ now: 1_100, limit: 10, leaseDurationMs: 100 })).toEqual([]);
    expect(
      getDb().prepare("SELECT status, last_error_code FROM provider_state_cleanup_tasks WHERE id = ?").get(missing.id),
    ).toEqual({ status: "dead", last_error_code: "state_missing" });
  });

  it("dead-letters corrupt and mismatched provisional attempt ownership", () => {
    createAttempt({ attemptId: "attempt-corrupt", sessionKey: "session-corrupt" });
    const corrupt = enqueuePreparedProviderStateCleanupTask({
      locator: locator(1, "a"),
      owner: { attemptId: "attempt-corrupt", sessionKey: "session-corrupt", bootEpoch: "boot-attempt-corrupt" },
      now: 100,
    });
    publishTask(corrupt.id);
    getDb().exec("PRAGMA ignore_check_constraints = ON");
    getDb().prepare("UPDATE runtime_turn_attempts SET status = 'corrupt' WHERE attempt_id = ?").run("attempt-corrupt");
    getDb().exec("PRAGMA ignore_check_constraints = OFF");

    createAttempt({ attemptId: "attempt-mismatch", sessionKey: "actual-session" });
    const mismatch = enqueuePreparedProviderStateCleanupTask({
      locator: locator(1, "b"),
      owner: { attemptId: "attempt-mismatch", sessionKey: "wrong-session", bootEpoch: "boot-attempt-mismatch" },
      now: 100,
    });
    publishTask(mismatch.id);

    expect(claimProviderStateCleanupTasks({ now: 500, limit: 10, leaseDurationMs: 100 })).toEqual([]);
    expect(
      getDb()
        .prepare("SELECT id, status, last_error_code FROM provider_state_cleanup_tasks ORDER BY idempotency_key")
        .all(),
    ).toEqual(
      expect.arrayContaining([
        { id: corrupt.id, status: "dead", last_error_code: "schema_mismatch" },
        { id: mismatch.id, status: "dead", last_error_code: "binding_mismatch" },
      ]),
    );
  });

  it("dead-letters each internally inconsistent attempt invariant instead of claiming", () => {
    const corruptions = [
      "last_heartbeat_at = started_at - 1",
      "lease_expires_at = last_heartbeat_at",
      "completed_at = last_heartbeat_at",
      "status = 'complete', completed_at = NULL",
      "status = 'complete', completed_at = last_heartbeat_at - 1",
    ];

    for (const [index, corruption] of corruptions.entries()) {
      const suffix = String.fromCharCode("a".charCodeAt(0) + index);
      const attemptId = `attempt-invalid-invariant-${suffix}`;
      const sessionKey = `session-invalid-invariant-${suffix}`;
      createAttempt({ attemptId, sessionKey });
      const task = enqueuePreparedProviderStateCleanupTask({
        locator: locator(index + 1, suffix),
        owner: { attemptId, sessionKey, bootEpoch: `boot-${attemptId}` },
        now: 100,
      });
      publishTask(task.id);
      getDb().exec("PRAGMA ignore_check_constraints = ON");
      getDb().prepare(`UPDATE runtime_turn_attempts SET ${corruption} WHERE attempt_id = ?`).run(attemptId);
      getDb().exec("PRAGMA ignore_check_constraints = OFF");

      expect(claimProviderStateCleanupTasks({ now: 1_000, limit: 1, leaseDurationMs: 100 })).toEqual([]);
      expect(
        getDb().prepare("SELECT status, last_error_code FROM provider_state_cleanup_tasks WHERE id = ?").get(task.id),
      ).toEqual({ status: "dead", last_error_code: "schema_mismatch" });
    }
  });

  it("reclaims expired leases and rejects stale completion", () => {
    const task = enqueuePublishedProviderStateCleanupTask({
      operation: "delete_state",
      locator: locator(),
      now: 100,
    });
    const first = claimProviderStateCleanupTasks({ now: 100, limit: 1, leaseDurationMs: 50 })[0]!;
    expect(completeProviderStateCleanupTask({ id: task.id, leaseId: "wrong", now: 120 })).toBe(false);
    expect(claimProviderStateCleanupTasks({ now: 149, limit: 1, leaseDurationMs: 50 })).toEqual([]);

    const second = claimProviderStateCleanupTasks({ now: 150, limit: 1, leaseDurationMs: 50 })[0]!;
    expect(second.leaseId).not.toBe(first.leaseId);
    expect(second.attemptCount).toBe(2);
    expect(completeProviderStateCleanupTask({ id: task.id, leaseId: first.leaseId!, now: 151 })).toBe(false);
    expect(completeProviderStateCleanupTask({ id: task.id, leaseId: second.leaseId!, now: 151 })).toBe(true);
    expect(getDb().prepare("SELECT id FROM provider_state_cleanup_tasks WHERE id = ?").get(task.id)).toBeNull();
  });

  it("applies bounded retry backoff and dead-letters non-retryable failures with allowlisted codes", () => {
    const retry = enqueuePublishedProviderStateCleanupTask({
      operation: "delete_state",
      locator: locator(1, "a"),
      now: 100,
    });
    const dead = enqueuePublishedProviderStateCleanupTask({
      operation: "delete_state",
      locator: locator(1, "b"),
      now: 100,
    });
    const claimed = claimProviderStateCleanupTasks({ now: 100, limit: 2, leaseDurationMs: 100 });
    const retryLease = claimed.find((task) => task.id === retry.id)!;
    const deadLease = claimed.find((task) => task.id === dead.id)!;

    expect(
      failProviderStateCleanupTask({
        id: retry.id,
        leaseId: retryLease.leaseId!,
        errorCode: "io_transient",
        now: 110,
        baseBackoffMs: 20,
        maxBackoffMs: 30,
      }),
    ).toBe(true);
    expect(
      getDb()
        .prepare(
          "SELECT status, next_attempt_at, lease_id, leased_until, last_error_code FROM provider_state_cleanup_tasks WHERE id = ?",
        )
        .get(retry.id),
    ).toEqual({
      status: "failed",
      next_attempt_at: 130,
      lease_id: null,
      leased_until: null,
      last_error_code: "io_transient",
    });
    expect(claimProviderStateCleanupTasks({ now: 129, limit: 1, leaseDurationMs: 100 })).toEqual([]);
    expect(claimProviderStateCleanupTasks({ now: 130, limit: 1, leaseDurationMs: 100 })[0]).toMatchObject({
      id: retry.id,
      attemptCount: 2,
    });

    expect(
      failProviderStateCleanupTask({
        id: dead.id,
        leaseId: deadLease.leaseId!,
        errorCode: "invalid_locator",
        now: 120,
      }),
    ).toBe(true);
    expect(
      getDb().prepare("SELECT status, last_error_code FROM provider_state_cleanup_tasks WHERE id = ?").get(dead.id),
    ).toEqual({ status: "dead", last_error_code: "invalid_locator" });
  });

  it("derives retry versus dead disposition from the allowlisted error code", () => {
    const transient = enqueuePublishedProviderStateCleanupTask({
      operation: "delete_state",
      locator: locator(1, "a"),
      now: 100,
    });
    const unknown = enqueuePublishedProviderStateCleanupTask({
      operation: "delete_state",
      locator: locator(1, "b"),
      now: 100,
    });
    const claimed = claimProviderStateCleanupTasks({ now: 100, limit: 2, leaseDurationMs: 100 });
    const transientLease = claimed.find((task) => task.id === transient.id)!;
    const unknownLease = claimed.find((task) => task.id === unknown.id)!;
    const transientInput = {
      id: transient.id,
      leaseId: transientLease.leaseId!,
      errorCode: "io_transient" as const,
      now: 110,
      baseBackoffMs: 20,
    };
    const unknownInput = {
      id: unknown.id,
      leaseId: unknownLease.leaseId!,
      errorCode: "unknown" as const,
      now: 110,
      baseBackoffMs: 20,
    };

    expect(failProviderStateCleanupTask(transientInput)).toBe(true);
    expect(failProviderStateCleanupTask(unknownInput)).toBe(true);
    expect(
      getDb()
        .prepare("SELECT id, status, next_attempt_at, last_error_code FROM provider_state_cleanup_tasks ORDER BY id")
        .all(),
    ).toEqual(
      expect.arrayContaining([
        { id: transient.id, status: "failed", next_attempt_at: 130, last_error_code: "io_transient" },
        { id: unknown.id, status: "dead", next_attempt_at: 0, last_error_code: "unknown" },
      ]),
    );
  });
});
