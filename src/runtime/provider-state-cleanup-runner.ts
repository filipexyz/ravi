import { executeWrite } from "../db/write-retry.js";
import { getDb } from "../router/router-db.js";
import { logger } from "../utils/logger.js";
import {
  claimProviderStateCleanupTasks,
  completeProviderStateCleanupTask,
  failProviderStateCleanupTask,
  holdProviderStateCleanupTaskForUnavailableExecutor,
  renewProviderStateCleanupTaskLease,
  type ProviderStateCleanupErrorCode,
  type ProviderStateCleanupOperation,
  type ProviderStateCleanupTask,
} from "./provider-state-cleanup-store.js";
import {
  providerStatePublishIntentIsResolved,
  reconcileProviderStatePublishIntent,
  type ProviderStateLocatorOwnershipPredicate,
} from "./provider-state-lifecycle.js";
import {
  classifyKimiCodeStateError,
  closeKimiCodePublishIntentCursor,
  executeKimiCodeDeleteStateCleanup,
  executeKimiCodeProvisionalExactCleanup,
  executeKimiCodeRetireRevisionCleanup,
  listKimiCodePublishIntents,
  readKimiCodePublishIntent,
  removeKimiCodePublishIntent,
  parseKimiCodeCleanupLocator,
  serializeKimiCodeCleanupLocator,
  type KimiCodePublishIntentCursor,
} from "./kimi-code-state.js";
import { KIMI_CODE_PROVIDER_ID } from "./kimi-code-models.js";

const log = logger.child("runtime:provider-state-cleanup");
const DEFAULT_CLAIM_LIMIT = 8;
const DEFAULT_RECONCILE_LIMIT = 32;
const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_INTERVAL_MS = 10_000;
const KIMI_OWNERSHIP_CANDIDATE_LIMIT = 16;

export interface ProviderStateCleanupExecutorResult {
  complete: boolean;
  processed?: number;
}

export interface ProviderStateCleanupExecutorContext {
  signal: AbortSignal;
}

export type ProviderStateCleanupExecutor = (
  task: Readonly<ProviderStateCleanupTask>,
  context: Readonly<ProviderStateCleanupExecutorContext>,
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
  private readonly ownershipPredicates = new Map<string, ProviderStateLocatorOwnershipPredicate>();
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

  registerLocatorOwnership(provider: string, predicate: ProviderStateLocatorOwnershipPredicate): void {
    if (this.sealed) throw new Error("Provider cleanup executor registry is already active");
    if (this.ownershipPredicates.has(provider)) {
      throw new Error(`Provider locator ownership predicate already registered for ${provider}`);
    }
    this.ownershipPredicates.set(provider, predicate);
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

  locatorOwnershipFor(provider: string): ProviderStateLocatorOwnershipPredicate | undefined {
    return this.ownershipPredicates.get(provider);
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
  setLeaseInterval?: (callback: () => void, intervalMs: number) => unknown;
  clearLeaseInterval?: (timer: unknown) => void;
  unknownExecutorRetryDelayMs?: number;
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
  private readonly scheduleLease: (callback: () => void, intervalMs: number) => unknown;
  private readonly cancelLease: (timer: unknown) => void;
  private readonly leaseRenewIntervalMs: number;
  private readonly unknownExecutorRetryDelayMs: number;
  private readonly onDrain: ((result: ProviderStateCleanupDrainResult) => void) | undefined;
  private timer: unknown;
  private active = false;
  private stopping = false;
  private starting: Promise<void> | undefined;
  private inFlight: Promise<void> | undefined;
  private readonly activeExecutorControllers = new Set<AbortController>();

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
    this.scheduleLease =
      options.setLeaseInterval ?? ((callback, intervalMs) => setInterval(callback, intervalMs));
    this.cancelLease =
      options.clearLeaseInterval ?? ((timer) => clearInterval(timer as ReturnType<typeof setInterval>));
    this.leaseRenewIntervalMs = Math.max(1, Math.floor(this.leaseDurationMs / 4));
    this.unknownExecutorRetryDelayMs = positiveInteger(
      options.unknownExecutorRetryDelayMs ?? this.intervalMs,
      "unknownExecutorRetryDelayMs",
    );
    this.onDrain = options.onDrain;
  }

  async start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.active) return;
    this.active = true;
    this.stopping = false;
    const startup = (async () => {
      this.registry.activate();
      await this.requestBoundedDrain();
      if (!this.active) return;
      this.timer = this.schedule(() => {
        void this.requestBoundedDrain().catch((error) =>
          log.error("Provider cleanup periodic drain failed", { error }),
        );
      }, this.intervalMs);
    })();
    this.starting = startup;
    try {
      await startup;
    } catch (error) {
      this.active = false;
      throw error;
    } finally {
      this.starting = undefined;
    }
  }

  async stop(): Promise<void> {
    this.active = false;
    this.stopping = true;
    if (this.timer !== undefined) {
      this.cancel(this.timer);
      this.timer = undefined;
    }
    for (const controller of this.activeExecutorControllers) controller.abort();
    await this.inFlight;
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
      if (this.stopping) {
        if (requeueIncompleteProviderStateCleanupTask(task.id, leaseId, this.now())) result.requeued += 1;
        continue;
      }
      const executor = this.registry.executorFor(task);
      if (!executor) {
        if (
          holdProviderStateCleanupTaskForUnavailableExecutor({
            id: task.id,
            leaseId,
            now: this.now(),
            retryDelayMs: this.unknownExecutorRetryDelayMs,
          })
        ) {
          result.failed += 1;
        }
        continue;
      }
      const abortController = new AbortController();
      this.activeExecutorControllers.add(abortController);
      let leaseLost = false;
      const leaseHeartbeat = this.scheduleLease(() => {
        try {
          if (
            !renewProviderStateCleanupTaskLease({
              id: task.id,
              leaseId,
              leaseDurationMs: this.leaseDurationMs,
              now: this.now(),
            })
          ) {
            leaseLost = true;
            abortController.abort();
          }
        } catch {
          leaseLost = true;
          abortController.abort();
        }
      }, this.leaseRenewIntervalMs);
      try {
        const execution = await executor(task, { signal: abortController.signal });
        if (leaseLost) continue;
        const finishedAt = this.now();
        if (abortController.signal.aborted || !execution.complete) {
          if (requeueIncompleteProviderStateCleanupTask(task.id, leaseId, finishedAt)) result.requeued += 1;
        } else if (completeProviderStateCleanupTask({ id: task.id, leaseId, now: finishedAt })) {
          result.completed += 1;
        }
      } catch (error) {
        if (leaseLost) continue;
        if (abortController.signal.aborted) {
          if (requeueIncompleteProviderStateCleanupTask(task.id, leaseId, this.now())) result.requeued += 1;
          continue;
        }
        const code = error instanceof ProviderStateCleanupTaskError ? error.code : "unknown";
        failProviderStateCleanupTask({ id: task.id, leaseId, errorCode: code, now: this.now() });
        result.failed += 1;
      } finally {
        this.cancelLease(leaseHeartbeat);
        this.activeExecutorControllers.delete(abortController);
      }
    }
    return result;
  }

  private requestBoundedDrain(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const drain = (async () => {
      await this.reconcileOnce();
      if (!this.active) return;
      const result = await this.drainOnce();
      this.onDrain?.(result);
    })();
    this.inFlight = drain;
    const clear = () => {
      if (this.inFlight === drain) this.inFlight = undefined;
    };
    void drain.then(clear, clear);
    return drain;
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
        const isLocatorOwned = registry.locatorOwnershipFor(KIMI_CODE_PROVIDER_ID);
        if (!isLocatorOwned) throw new ProviderStateCleanupTaskError("executor_unavailable");
        const decision = reconcileProviderStatePublishIntent({
          provider: KIMI_CODE_PROVIDER_ID,
          intent,
          isLocatorOwned,
        });
        if (providerStatePublishIntentIsResolved(decision)) {
          await removeKimiCodePublishIntent(candidate.path);
        }
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
  registry.registerLocatorOwnership(KIMI_CODE_PROVIDER_ID, (locatorJson, database) => {
    let sessionId: string;
    try {
      sessionId = parseKimiCodeCleanupLocator(locatorJson).sessionId;
    } catch {
      return false;
    }
    const malformedTarget = database
      .prepare(
        `SELECT 1 FROM sessions
         WHERE runtime_provider = ? AND runtime_session_display_id = ?
           AND runtime_session_json IS NOT NULL AND NOT json_valid(runtime_session_json)
         LIMIT 1`,
      )
      .get(KIMI_CODE_PROVIDER_ID, sessionId);
    if (malformedTarget) return true;

    const candidates = database
      .prepare(
        `SELECT runtime_session_json FROM sessions
         WHERE runtime_provider = ? AND runtime_session_json IS NOT NULL
           AND json_valid(runtime_session_json)
           AND json_type(runtime_session_json, '$.sessionId') = 'text'
           AND json_extract(runtime_session_json, '$.sessionId') = ?
         LIMIT ?`,
      )
      .all(KIMI_CODE_PROVIDER_ID, sessionId, KIMI_OWNERSHIP_CANDIDATE_LIMIT + 1) as Array<{
      runtime_session_json: string;
    }>;
    if (candidates.length > KIMI_OWNERSHIP_CANDIDATE_LIMIT) return true;
    return candidates.some((row) => {
      try {
        return serializeKimiCodeCleanupLocator({ params: JSON.parse(row.runtime_session_json) }) === locatorJson;
      } catch {
        return true;
      }
    });
  });
  registry.registerExecutor(KIMI_CODE_PROVIDER_ID, "provisional_exact", async (task, context) => {
    if (!task.ownerAttemptId) throw new ProviderStateCleanupTaskError("schema_mismatch");
    try {
      await executeKimiCodeProvisionalExactCleanup({
        locatorJson: task.locatorJson,
        taskId: task.id,
        ownerAttemptId: task.ownerAttemptId,
        signal: context.signal,
        isLocatorOwned: () => {
          const predicate = registry.locatorOwnershipFor(KIMI_CODE_PROVIDER_ID);
          if (!predicate) throw new ProviderStateCleanupTaskError("executor_unavailable");
          return predicate(task.locatorJson, getDb());
        },
      });
      return { complete: true };
    } catch (error) {
      throw asKimiTaskError(error);
    }
  });
  registry.registerExecutor(KIMI_CODE_PROVIDER_ID, "delete_state", async (task, context) => {
    try {
      return await executeKimiCodeDeleteStateCleanup({
        locatorJson: task.locatorJson,
        taskId: task.id,
        signal: context.signal,
      });
    } catch (error) {
      throw asKimiTaskError(error);
    }
  });
  registry.registerExecutor(KIMI_CODE_PROVIDER_ID, "retire_revision", async (task, context) => {
    if (!task.successorLocatorJson) throw new ProviderStateCleanupTaskError("schema_mismatch");
    try {
      await executeKimiCodeRetireRevisionCleanup({
        locatorJson: task.locatorJson,
        successorLocatorJson: task.successorLocatorJson,
        taskId: task.id,
        signal: context.signal,
      });
      return { complete: true };
    } catch (error) {
      throw asKimiTaskError(error);
    }
  });
  installKimiCodeIntentReconciler(registry);
}
