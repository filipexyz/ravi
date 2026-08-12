import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getDb } from "../router/router-db.js";
import { getOrCreateSession, getSession } from "../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
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
  enqueuePublishedProviderStateCleanupTask,
  failProviderStateCleanupTask,
  mutateSessionAndEnqueueProviderStateCleanup,
  parseProviderStateCleanupLocator,
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
        retryable: true,
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
        retryable: false,
        now: 120,
      }),
    ).toBe(true);
    expect(
      getDb().prepare("SELECT status, last_error_code FROM provider_state_cleanup_tasks WHERE id = ?").get(dead.id),
    ).toEqual({ status: "dead", last_error_code: "invalid_locator" });
  });
});
