import { executeWrite } from "../db/write-retry.js";
import { getDb } from "../router/router-db.js";
import { logger } from "../utils/logger.js";
import {
  claimProviderStateCleanupTasks,
  completeProviderStateCleanupTask,
  failProviderStateCleanupTask,
  type ProviderStateCleanupErrorCode,
  type ProviderStateCleanupOperation,
  type ProviderStateCleanupTask,
} from "./provider-state-cleanup-store.js";
import { isProviderStateLocatorOwned, reconcileProviderStatePublishIntent } from "./provider-state-lifecycle.js";
import {
  classifyKimiCodeStateError,
  closeKimiCodePublishIntentCursor,
  executeKimiCodeDeleteStateCleanup,
  executeKimiCodeProvisionalExactCleanup,
  executeKimiCodeRetireRevisionCleanup,
  listKimiCodePublishIntents,
  readKimiCodePublishIntent,
  removeKimiCodePublishIntent,
  type KimiCodePublishIntentCursor,
} from "./kimi-code-state.js";
import { KIMI_CODE_PROVIDER_ID } from "./kimi-code-models.js";

const log = logger.child("runtime:provider-state-cleanup");
const DEFAULT_CLAIM_LIMIT = 8;
const DEFAULT_RECONCILE_LIMIT = 32;
const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_INTERVAL_MS = 10_000;

export interface ProviderStateCleanupExecutorResult {
  complete: boolean;
  processed?: number;
}

export type ProviderStateCleanupExecutor = (
  task: Readonly<ProviderStateCleanupTask>,
) => Promise<ProviderStateCleanupExecutorResult>;

export interface ProviderStateIntentReconcileResult {
  processed: number;
  complete: boolean;
}

export type ProviderStateIntentReconciler = (input: {
  limit: number;
}) => Promise<ProviderStateIntentReconcileResult>;

export class ProviderStateCleanupTaskError extends Error {
  readonly code: ProviderStateCleanupErrorCode;

  constructor(code: ProviderStateCleanupErrorCode) {
    super(`Provider cleanup failed: ${code}`);
    this.name = "ProviderStateCleanupTaskError";
    this.code = code;
  }
}

function executorKey(provider: string, operation: ProviderStateCleanupOperation): string {
  return `${provider}\0${operation}`;
}

export class ProviderStateCleanupExecutorRegistry {
  private readonly executors = new Map<string, ProviderStateCleanupExecutor>();
  private readonly reconcilers = new Map<string, ProviderStateIntentReconciler>();
  private sealed = false;

  registerExecutor(
    provider: string,
    operation: ProviderStateCleanupOperation,
    executor: ProviderStateCleanupExecutor,
  ): void {
    if (this.sealed) throw new Error("Provider cleanup executor registry is already active");
    const key = executorKey(provider, operation);
    if (this.executors.has(key)) throw new Error(`Provider cleanup executor already registered for ${provider}`);
    this.executors.set(key, executor);
  }

  registerReconciler(provider: string, reconciler: ProviderStateIntentReconciler): void {
    if (this.sealed) throw new Error("Provider cleanup executor registry is already active");
    if (this.reconcilers.has(provider)) throw new Error(`Provider intent reconciler already registered for ${provider}`);
    this.reconcilers.set(provider, reconciler);
  }

  activate(): void {
    this.sealed = true;
  }

  executorFor(task: Readonly<ProviderStateCleanupTask>): ProviderStateCleanupExecutor | undefined {
    return this.executors.get(executorKey(task.provider, task.operation));
  }

  intentReconcilers(): readonly ProviderStateIntentReconciler[] {
    return [...this.reconcilers.values()];
  }
}

export interface ProviderStateCleanupDrainResult {
  claimed: number;
  completed: number;
  requeued: number;
  failed: number;
}

export interface ProviderStateCleanupRunnerOptions {
  registry: ProviderStateCleanupExecutorRegistry;
  claimLimit?: number;
  reconcileLimit?: number;
  leaseDurationMs?: number;
  intervalMs?: number;
  now?: () => number;
  setInterval?: (callback: () => void, intervalMs: number) => unknown;
  clearInterval?: (timer: unknown) => void;
  onDrain?: (result: ProviderStateCleanupDrainResult) => void;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive safe integer`);
  return value;
}

export class ProviderStateCleanupRunner {
  private readonly registry: ProviderStateCleanupExecutorRegistry;
  private readonly claimLimit: number;
  private readonly reconcileLimit: number;
  private readonly leaseDurationMs: number;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, intervalMs: number) => unknown;
  private readonly cancel: (timer: unknown) => void;
  private readonly onDrain: ((result: ProviderStateCleanupDrainResult) => void) | undefined;
  private timer: unknown;
  private draining = false;

  constructor(options: ProviderStateCleanupRunnerOptions) {
    this.registry = options.registry;
    this.claimLimit = positiveInteger(options.claimLimit ?? DEFAULT_CLAIM_LIMIT, "claimLimit");
    this.reconcileLimit = positiveInteger(options.reconcileLimit ?? DEFAULT_RECONCILE_LIMIT, "reconcileLimit");
    this.leaseDurationMs = positiveInteger(options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS, "leaseDurationMs");
    this.intervalMs = positiveInteger(options.intervalMs ?? DEFAULT_INTERVAL_MS, "intervalMs");
    this.now = options.now ?? Date.now;
    this.schedule =
      options.setInterval ?? ((callback, intervalMs) => setInterval(callback, intervalMs));
    this.cancel = options.clearInterval ?? ((timer) => clearInterval(timer as ReturnType<typeof setInterval>));
    this.onDrain = options.onDrain;
  }

  async start(): Promise<void> {
    if (this.timer !== undefined) return;
    this.registry.activate();
    await this.runBoundedDrain();
    this.timer = this.schedule(() => {
      void this.runBoundedDrain().catch((error) => log.error("Provider cleanup periodic drain failed", { error }));
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer === undefined) return;
    this.cancel(this.timer);
    this.timer = undefined;
  }

  async reconcileOnce(): Promise<void> {
    for (const reconcile of this.registry.intentReconcilers()) {
      await reconcile({ limit: this.reconcileLimit });
    }
  }

  async drainOnce(): Promise<ProviderStateCleanupDrainResult> {
    const now = this.now();
    const tasks = claimProviderStateCleanupTasks({
      now,
      limit: this.claimLimit,
      leaseDurationMs: this.leaseDurationMs,
    });
    const result: ProviderStateCleanupDrainResult = {
      claimed: tasks.length,
      completed: 0,
      requeued: 0,
      failed: 0,
    };
    for (const task of tasks) {
      const leaseId = task.leaseId;
      if (!leaseId) continue;
      const executor = this.registry.executorFor(task);
      if (!executor) {
        failProviderStateCleanupTask({ id: task.id, leaseId, errorCode: "executor_unavailable", now: this.now() });
        result.failed += 1;
        continue;
      }
      try {
        const execution = await executor(task);
        const finishedAt = this.now();
        if (!execution.complete) {
          requeueIncompleteProviderStateCleanupTask(task.id, leaseId, finishedAt);
          result.requeued += 1;
        } else if (completeProviderStateCleanupTask({ id: task.id, leaseId, now: finishedAt })) {
          result.completed += 1;
        }
      } catch (error) {
        const code = error instanceof ProviderStateCleanupTaskError ? error.code : "unknown";
        failProviderStateCleanupTask({ id: task.id, leaseId, errorCode: code, now: this.now() });
        result.failed += 1;
      }
    }
    return result;
  }

  private async runBoundedDrain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      await this.reconcileOnce();
      const result = await this.drainOnce();
      this.onDrain?.(result);
    } finally {
      this.draining = false;
    }
  }
}

function requeueIncompleteProviderStateCleanupTask(id: string, leaseId: string, now: number): boolean {
  return executeWrite(
    getDb(),
    (database) =>
      database
        .prepare(
          `UPDATE provider_state_cleanup_tasks
           SET status = 'failed', next_attempt_at = ?, lease_id = NULL,
             leased_until = NULL, last_error_code = NULL, updated_at = ?
           WHERE id = ? AND status = 'leased' AND lease_id = ? AND leased_until > ?`,
        )
        .run(now, now, id, leaseId, now).changes === 1,
    { label: "provider-state-cleanup-requeue-incomplete" },
  );
}

function isKimiLocatorOwned(locatorJson: string): boolean {
  return isProviderStateLocatorOwned(locatorJson);
}

function asKimiTaskError(error: unknown): ProviderStateCleanupTaskError {
  return new ProviderStateCleanupTaskError(classifyKimiCodeStateError(error).code);
}

function installKimiCodeIntentReconciler(registry: ProviderStateCleanupExecutorRegistry): void {
  let cursor: KimiCodePublishIntentCursor | undefined;
  registry.registerReconciler(KIMI_CODE_PROVIDER_ID, async ({ limit }) => {
    let page;
    try {
      page = await listKimiCodePublishIntents({ limit, ...(cursor ? { cursor } : {}) });
      cursor = page.nextCursor;
      for (const candidate of page.candidates) {
        if (candidate.kind === "invalid") continue;
        const intent = await readKimiCodePublishIntent(candidate.path);
        const decision = reconcileProviderStatePublishIntent({ intent });
        if (decision === "remove_owned_intent") await removeKimiCodePublishIntent(candidate.path);
      }
      return { processed: page.candidates.length, complete: !page.nextCursor };
    } catch (error) {
      if (cursor) {
        await closeKimiCodePublishIntentCursor(cursor).catch(() => undefined);
        cursor = undefined;
      }
      throw asKimiTaskError(error);
    }
  });
}

/** Install built-in providers before reconciliation, draining, or runtime intake. */
export function installProviderStateCleanupExecutors(registry: ProviderStateCleanupExecutorRegistry): void {
  registry.registerExecutor(KIMI_CODE_PROVIDER_ID, "provisional_exact", async (task) => {
    if (!task.ownerAttemptId) throw new ProviderStateCleanupTaskError("schema_mismatch");
    try {
      await executeKimiCodeProvisionalExactCleanup({
        locatorJson: task.locatorJson,
        taskId: task.id,
        ownerAttemptId: task.ownerAttemptId,
        isLocatorOwned: () => isKimiLocatorOwned(task.locatorJson),
      });
      return { complete: true };
    } catch (error) {
      throw asKimiTaskError(error);
    }
  });
  registry.registerExecutor(KIMI_CODE_PROVIDER_ID, "delete_state", async (task) => {
    try {
      return await executeKimiCodeDeleteStateCleanup({ locatorJson: task.locatorJson, taskId: task.id });
    } catch (error) {
      throw asKimiTaskError(error);
    }
  });
  registry.registerExecutor(KIMI_CODE_PROVIDER_ID, "retire_revision", async (task) => {
    if (!task.successorLocatorJson) throw new ProviderStateCleanupTaskError("schema_mismatch");
    try {
      await executeKimiCodeRetireRevisionCleanup({
        locatorJson: task.locatorJson,
        successorLocatorJson: task.successorLocatorJson,
        taskId: task.id,
      });
      return { complete: true };
    } catch (error) {
      throw asKimiTaskError(error);
    }
  });
  installKimiCodeIntentReconciler(registry);
}
