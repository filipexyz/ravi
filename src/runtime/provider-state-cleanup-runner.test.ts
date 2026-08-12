import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { join } from "node:path";
import { getDb } from "../router/router-db.js";
import { getOrCreateSession } from "../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { KIMI_CODE_PROVIDER_ID } from "./kimi-code-models.js";
import { serializeKimiCodeCleanupLocator } from "./kimi-code-state.js";
import {
  claimProviderStateCleanupTasks,
  enqueuePublishedProviderStateCleanupTask,
} from "./provider-state-cleanup-store.js";
import {
  installProviderStateCleanupExecutors,
  ProviderStateCleanupExecutorRegistry,
  ProviderStateCleanupRunner,
  ProviderStateCleanupTaskError,
} from "./provider-state-cleanup-runner.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-provider-cleanup-runner-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function locator(provider = "test-provider") {
  return {
    schemaVersion: 1 as const,
    provider,
    model: "test-model",
    sessionId: "00000000-0000-4000-8000-00000000000a",
    revision: 1,
    cwd: "/workspace/project",
    workspaceIdentity: { realpath: "/workspace/project", device: "1", inode: "2" },
    sessionFile: "/private/a/revision-1.json",
    lastCommittedTurnId: "turn-1",
  };
}

function enqueue(provider = "test-provider", operation: "delete_state" | "retire_revision" = "delete_state") {
  return enqueuePublishedProviderStateCleanupTask({
    operation,
    locator: locator(provider),
    ...(operation === "retire_revision" ? { successorLocator: { ...locator(provider), revision: 2 } } : {}),
    now: 100,
  });
}

describe("provider cleanup executor registry and runner", () => {
  it("runs registered executors and completes only final bounded batches", async () => {
    const task = enqueue();
    const execute = mock()
      .mockResolvedValueOnce({ complete: false, processed: 64 })
      .mockResolvedValueOnce({ complete: true, processed: 1 });
    const registry = new ProviderStateCleanupExecutorRegistry();
    registry.registerExecutor("test-provider", "delete_state", execute);
    const runner = new ProviderStateCleanupRunner({
      registry,
      claimLimit: 1,
      leaseDurationMs: 1_000,
      now: () => 200,
    });

    expect(await runner.drainOnce()).toEqual({ claimed: 1, completed: 0, requeued: 1, failed: 0 });
    expect(
      getDb().prepare("SELECT status FROM provider_state_cleanup_tasks WHERE id = ?").get(task.id),
    ).toEqual({ status: "failed" });
    expect(await runner.drainOnce()).toEqual({ claimed: 1, completed: 1, requeued: 0, failed: 0 });
    expect(getDb().prepare("SELECT id FROM provider_state_cleanup_tasks WHERE id = ?").get(task.id)).toBeNull();
  });

  it("holds unknown executors with only executor_unavailable diagnostics", async () => {
    const task = enqueue("missing-provider");
    let now = 200;
    const runner = new ProviderStateCleanupRunner({
      registry: new ProviderStateCleanupExecutorRegistry(),
      claimLimit: 1,
      leaseDurationMs: 1_000,
      intervalMs: 50,
      now: () => now,
    });

    expect(await runner.drainOnce()).toEqual({ claimed: 1, completed: 0, requeued: 0, failed: 1 });
    expect(await runner.drainOnce()).toEqual({ claimed: 0, completed: 0, requeued: 0, failed: 0 });
    expect(
      getDb()
        .prepare(
          "SELECT status, attempt_count, last_error_code, locator_json FROM provider_state_cleanup_tasks WHERE id = ?",
        )
        .get(task.id),
    ).toEqual({
      status: "failed",
      attempt_count: 0,
      last_error_code: "executor_unavailable",
      locator_json: task.locatorJson,
    });

    const installedRegistry = new ProviderStateCleanupExecutorRegistry();
    installedRegistry.registerExecutor("missing-provider", "delete_state", async () => ({ complete: true }));
    const restartedRunner = new ProviderStateCleanupRunner({
      registry: installedRegistry,
      claimLimit: 1,
      leaseDurationMs: 1_000,
      now: () => now,
    });
    now = 250;
    expect(await restartedRunner.drainOnce()).toEqual({ claimed: 1, completed: 1, requeued: 0, failed: 0 });
    expect(getDb().prepare("SELECT id FROM provider_state_cleanup_tasks WHERE id = ?").get(task.id)).toBeNull();
  });

  it("delays unknown executors so later registered work is not starved", async () => {
    enqueue("missing-provider-a");
    enqueue("missing-provider-b");
    enqueue("missing-provider-c");
    const known = enqueue("known-provider");
    getDb().prepare("UPDATE provider_state_cleanup_tasks SET created_at = 101 WHERE id = ?").run(known.id);
    const registry = new ProviderStateCleanupExecutorRegistry();
    registry.registerExecutor("known-provider", "delete_state", async () => ({ complete: true }));
    const runner = new ProviderStateCleanupRunner({
      registry,
      claimLimit: 2,
      leaseDurationMs: 1_000,
      intervalMs: 100,
      now: () => 200,
    });

    expect(await runner.drainOnce()).toEqual({ claimed: 2, completed: 0, requeued: 0, failed: 2 });
    expect(await runner.drainOnce()).toEqual({ claimed: 2, completed: 1, requeued: 0, failed: 1 });
    expect(getDb().prepare("SELECT id FROM provider_state_cleanup_tasks WHERE id = ?").get(known.id)).toBeNull();
  });

  it("persists typed allowlisted failures without parsing secret error messages", async () => {
    const task = enqueue();
    const registry = new ProviderStateCleanupExecutorRegistry();
    registry.registerExecutor("test-provider", "delete_state", async () => {
      throw new ProviderStateCleanupTaskError("foreign_root");
    });
    const runner = new ProviderStateCleanupRunner({
      registry,
      claimLimit: 1,
      leaseDurationMs: 1_000,
      now: () => 200,
    });

    await runner.drainOnce();
    expect(
      getDb().prepare("SELECT status, last_error_code FROM provider_state_cleanup_tasks WHERE id = ?").get(task.id),
    ).toEqual({ status: "dead", last_error_code: "foreign_root" });
  });

  it("reconciles before startup drain and schedules bounded periodic drains", async () => {
    const order: string[] = [];
    const registry = new ProviderStateCleanupExecutorRegistry();
    registry.registerReconciler("test-provider", async ({ limit }) => {
      order.push(`reconcile:${limit}`);
      return { processed: 1, complete: true };
    });
    const scheduled: Array<() => void> = [];
    const runner = new ProviderStateCleanupRunner({
      registry,
      claimLimit: 2,
      reconcileLimit: 3,
      leaseDurationMs: 1_000,
      setInterval: (callback) => {
        scheduled.push(callback);
        return 1;
      },
      clearInterval: () => undefined,
      onDrain: () => order.push("drain"),
    });

    await runner.start();
    expect(order).toEqual(["reconcile:3", "drain"]);
    expect(() =>
      registry.registerExecutor("late-provider", "delete_state", async () => ({ complete: true })),
    ).toThrow("already active");
    expect(scheduled).toHaveLength(1);
    scheduled[0]!();
    await Promise.resolve();
    await runner.stop();
  });

  it("coalesces overlapping timer ticks and stop waits for the active drain", async () => {
    let releaseExecution!: () => void;
    const executionGate = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    const execute = mock(async () => {
      await executionGate;
      return { complete: true };
    });
    const registry = new ProviderStateCleanupExecutorRegistry();
    registry.registerExecutor("test-provider", "delete_state", execute);
    const scheduled: Array<() => void> = [];
    let cancelled = false;
    const runner = new ProviderStateCleanupRunner({
      registry,
      claimLimit: 1,
      leaseDurationMs: 1_000,
      now: () => 200,
      setInterval: (callback) => {
        scheduled.push(callback);
        return 1;
      },
      clearInterval: () => {
        cancelled = true;
      },
    });
    await runner.start();
    enqueue();

    scheduled[0]!();
    scheduled[0]!();
    await Promise.resolve();
    expect(execute).toHaveBeenCalledTimes(1);

    let stopped = false;
    const stopping = runner.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(cancelled).toBe(true);
    expect(stopped).toBe(false);

    releaseExecution();
    await stopping;
    expect(stopped).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("aborts an active executor before stop waits and requeues without finalizing", async () => {
    const task = enqueue();
    let entered!: () => void;
    const executorEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const registry = new ProviderStateCleanupExecutorRegistry();
    registry.registerExecutor("test-provider", "delete_state", async (_task, { signal }) => {
      entered();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { complete: true };
    });
    const runner = new ProviderStateCleanupRunner({
      registry,
      claimLimit: 1,
      leaseDurationMs: 1_000,
      now: () => 200,
    });

    const starting = runner.start();
    await executorEntered;
    await runner.stop();
    await starting;

    expect(
      getDb()
        .prepare("SELECT status, lease_id, leased_until FROM provider_state_cleanup_tasks WHERE id = ?")
        .get(task.id),
    ).toEqual({ status: "failed", lease_id: null, leased_until: null });
  });

  it("renews a running executor lease and aborts without finalizing after lease loss", async () => {
    const task = enqueue();
    let now = 200;
    let heartbeat!: () => void;
    let heartbeatInterval = 0;
    let heartbeatCleared = false;
    let releaseExecution!: () => void;
    const executionGate = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    let executorSignal: AbortSignal | undefined;
    const registry = new ProviderStateCleanupExecutorRegistry();
    registry.registerExecutor("test-provider", "delete_state", async (_task, context) => {
      executorSignal = context.signal;
      await executionGate;
      return { complete: true };
    });
    const runner = new ProviderStateCleanupRunner({
      registry,
      claimLimit: 1,
      leaseDurationMs: 100,
      now: () => now,
      setLeaseInterval: (callback, intervalMs) => {
        heartbeat = callback;
        heartbeatInterval = intervalMs;
        return 1;
      },
      clearLeaseInterval: () => {
        heartbeatCleared = true;
      },
    });

    const draining = runner.drainOnce();
    await Promise.resolve();
    expect(heartbeatInterval).toBeLessThan(100 / 3);
    now = 225;
    heartbeat();
    expect(
      getDb().prepare("SELECT leased_until FROM provider_state_cleanup_tasks WHERE id = ?").get(task.id),
    ).toEqual({ leased_until: 325 });

    now = 325;
    const replacement = claimProviderStateCleanupTasks({ now, limit: 1, leaseDurationMs: 100 })[0]!;
    heartbeat();
    expect(executorSignal?.aborted).toBe(true);
    releaseExecution();
    expect(await draining).toEqual({ claimed: 1, completed: 0, requeued: 0, failed: 0 });
    expect(heartbeatCleared).toBe(true);
    expect(
      getDb().prepare("SELECT lease_id FROM provider_state_cleanup_tasks WHERE id = ?").get(task.id),
    ).toEqual({ lease_id: replacement.leaseId });
  });

  it("does not schedule periodic work when the initial reconciliation drain fails", async () => {
    const registry = new ProviderStateCleanupExecutorRegistry();
    registry.registerReconciler("test-provider", async () => {
      throw new Error("startup reconciliation failed");
    });
    let scheduled = false;
    const runner = new ProviderStateCleanupRunner({
      registry,
      setInterval: () => {
        scheduled = true;
        return 1;
      },
    });

    await expect(runner.start()).rejects.toThrow("startup reconciliation failed");
    expect(scheduled).toBe(false);
    await runner.stop();
  });

  it("uses the registered Kimi canonical projection for host-extended session metadata", () => {
    const registry = new ProviderStateCleanupExecutorRegistry();
    installProviderStateCleanupExecutors(registry);
    const sessionId = "00000000-0000-4000-8000-000000000099";
    const params = {
      schemaVersion: 1 as const,
      provider: KIMI_CODE_PROVIDER_ID,
      model: "kimi-for-coding",
      sessionId,
      revision: 1,
      cwd: stateDir!,
      workspaceIdentity: { realpath: stateDir!, device: "1", inode: "2" },
      sessionFile: join(stateDir!, "runtime", "kimi-code", "sessions", sessionId, "revision-1.json"),
      lastCommittedTurnId: "turn-1",
    };
    const locatorJson = serializeKimiCodeCleanupLocator({ params });
    const session = getOrCreateSession("owned-kimi", "agent-a", stateDir!);
    getDb()
      .prepare("UPDATE sessions SET runtime_provider = ?, runtime_session_json = ? WHERE session_key = ?")
      .run(KIMI_CODE_PROVIDER_ID, JSON.stringify({ ...params, reservationId: "host-only" }), session.sessionKey);

    expect(registry.locatorOwnershipFor(KIMI_CODE_PROVIDER_ID)?.(locatorJson, getDb())).toBe(true);
  });

  it("uses indexed canonical session ids for Kimi ownership despite inconsistent display metadata", () => {
    const registry = new ProviderStateCleanupExecutorRegistry();
    installProviderStateCleanupExecutors(registry);
    const ownership = registry.locatorOwnershipFor(KIMI_CODE_PROVIDER_ID)!;
    const targetSessionId = "00000000-0000-4000-8000-000000000098";
    const targetParams = {
      schemaVersion: 1 as const,
      provider: KIMI_CODE_PROVIDER_ID,
      model: "kimi-for-coding",
      sessionId: targetSessionId,
      revision: 1,
      cwd: stateDir!,
      workspaceIdentity: { realpath: stateDir!, device: "1", inode: "2" },
      sessionFile: join(stateDir!, "runtime", "kimi-code", "sessions", targetSessionId, "revision-1.json"),
      lastCommittedTurnId: "turn-1",
    };
    const locatorJson = serializeKimiCodeCleanupLocator({ params: targetParams });

    for (let index = 0; index < 128; index += 1) {
      const unrelated = getOrCreateSession(`unrelated-kimi-${index}`, "agent-a", stateDir!);
      getDb()
        .prepare(
          "UPDATE sessions SET runtime_provider = ?, runtime_session_display_id = ?, runtime_session_json = ? WHERE session_key = ?",
        )
        .run(KIMI_CODE_PROVIDER_ID, `unrelated-${index}`, JSON.stringify({ invalid: true }), unrelated.sessionKey);
    }
    expect(ownership(locatorJson, getDb())).toBe(false);

    const inconsistent = getOrCreateSession("inconsistent-kimi", "agent-a", stateDir!);
    getDb()
      .prepare(
        "UPDATE sessions SET runtime_provider = ?, runtime_session_display_id = ?, runtime_session_json = ? WHERE session_key = ?",
      )
      .run(KIMI_CODE_PROVIDER_ID, "different-session-id", JSON.stringify(targetParams), inconsistent.sessionKey);

    expect(ownership(locatorJson, getDb())).toBe(true);

    getDb().prepare("DELETE FROM sessions WHERE session_key = ?").run(inconsistent.sessionKey);
    const malformedTarget = getOrCreateSession("malformed-target-kimi", "agent-a", stateDir!);
    getDb()
      .prepare(
        "UPDATE sessions SET runtime_provider = ?, runtime_session_display_id = ?, runtime_session_json = ? WHERE session_key = ?",
      )
      .run(KIMI_CODE_PROVIDER_ID, targetSessionId, "{malformed", malformedTarget.sessionKey);
    expect(ownership(locatorJson, getDb())).toBe(true);

    getDb().prepare("DELETE FROM sessions WHERE session_key = ?").run(malformedTarget.sessionKey);
    const owned = getOrCreateSession("exact-owned-kimi", "agent-a", stateDir!);
    getDb()
      .prepare(
        "UPDATE sessions SET runtime_provider = ?, runtime_session_display_id = ?, runtime_session_json = ? WHERE session_key = ?",
      )
      .run(
        KIMI_CODE_PROVIDER_ID,
        targetSessionId,
        JSON.stringify({ ...targetParams, hostMetadata: { source: "router" } }),
        owned.sessionKey,
      );
    expect(ownership(locatorJson, getDb())).toBe(true);

    const validPlan = getDb()
      .prepare(
        `EXPLAIN QUERY PLAN SELECT runtime_session_json FROM sessions
         WHERE runtime_provider = ? AND runtime_session_json IS NOT NULL
           AND json_valid(runtime_session_json)
           AND json_type(runtime_session_json, '$.sessionId') = 'text'
           AND json_extract(runtime_session_json, '$.sessionId') = ?
         LIMIT ?`,
      )
      .all(KIMI_CODE_PROVIDER_ID, targetSessionId, 17) as Array<{ detail: string }>;
    expect(validPlan.some(({ detail }) => detail.includes("idx_sessions_runtime_provider_json_session"))).toBe(true);

    const malformedPlan = getDb()
      .prepare(
        `EXPLAIN QUERY PLAN SELECT 1 FROM sessions
         WHERE runtime_provider = ? AND runtime_session_display_id = ?
           AND runtime_session_json IS NOT NULL AND NOT json_valid(runtime_session_json)
         LIMIT 1`,
      )
      .all(KIMI_CODE_PROVIDER_ID, targetSessionId) as Array<{ detail: string }>;
    expect(malformedPlan.some(({ detail }) => detail.includes("idx_sessions_runtime_provider_invalid_json"))).toBe(
      true,
    );
  });
});
