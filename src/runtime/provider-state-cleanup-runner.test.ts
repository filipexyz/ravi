import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { getDb } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { enqueuePublishedProviderStateCleanupTask } from "./provider-state-cleanup-store.js";
import {
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
    const runner = new ProviderStateCleanupRunner({
      registry: new ProviderStateCleanupExecutorRegistry(),
      claimLimit: 1,
      leaseDurationMs: 1_000,
      now: () => 200,
    });

    expect(await runner.drainOnce()).toEqual({ claimed: 1, completed: 0, requeued: 0, failed: 1 });
    expect(
      getDb()
        .prepare("SELECT status, last_error_code, locator_json FROM provider_state_cleanup_tasks WHERE id = ?")
        .get(task.id),
    ).toEqual({
      status: "failed",
      last_error_code: "executor_unavailable",
      locator_json: task.locatorJson,
    });
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
    expect(() => registry.registerExecutor("late-provider", "delete_state", execute)).toThrow("already active");
    expect(scheduled).toHaveLength(1);
    scheduled[0]!();
    await Promise.resolve();
    runner.stop();
  });
});
