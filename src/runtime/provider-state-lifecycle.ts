import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { executeWrite } from "../db/write-retry.js";
import { getDb } from "../router/router-db.js";
import type { SessionProviderStateMutationResult, SessionProviderStateOwnership } from "../router/types.js";
import {
  enqueuePreparedProviderStateCleanupTaskInTransaction,
  enqueuePublishedProviderStateCleanupTaskInTransaction,
  publishPreparedProviderStateCleanupTaskInTransaction,
  parseProviderStateCleanupLocator,
  recordInvalidProviderStatePublishIntentInTransaction,
  serializeProviderStateCleanupLocator,
} from "./provider-state-cleanup-store.js";
import type { RuntimeProviderStateLifecycle, RuntimeProviderStatePublishInput } from "./types.js";

export interface ProviderStateLifecycleAttemptBinding {
  attemptId: string;
  bootEpoch: string;
}

export interface CreateProviderStateLifecycleOptions {
  provider: string;
  sessionKey: string;
  admittedEpoch: number;
  currentAttempt(): ProviderStateLifecycleAttemptBinding | null;
  database?: Database;
  /** Host-owned monotonic-enough wall clock. Providers never supply cleanup timestamps. */
  now?: () => number;
  publishDeadlineMs?: number;
}

const DEFAULT_PUBLISH_DEADLINE_MS = 1_000;
const PROVIDER_STATE_ADOPTION_LOST = Symbol("provider-state-adoption-lost");
const RECONCILABLE_ATTEMPT_STATUSES = [
  "running",
  "complete",
  "failed",
  "interrupted",
  "timeout",
  "aborted",
] as const;

export class ProviderStateLifecycleOwnershipError extends Error {
  constructor() {
    super("Provider state publication ownership changed");
    this.name = "ProviderStateLifecycleOwnershipError";
  }
}

export interface ProviderStatePublishIntent {
  taskId: string;
  ownerAttemptId: string;
  locatorJson: string;
}

export type ProviderStatePublishIntentReconcileDecision =
  | "held_active_attempt"
  | "held_invalid_attempt"
  | "held_existing_task"
  | "remove_owned_intent"
  | "published_cleanup";

export function providerStatePublishIntentIsResolved(
  decision: ProviderStatePublishIntentReconcileDecision,
): boolean {
  return decision === "remove_owned_intent";
}

interface OwnedSessionRow {
  lifecycle_generation: number;
}

interface OwnedAttemptRow {
  status: string;
  session_key: string;
  provider: string;
  boot_epoch: string;
  lease_expires_at: number;
}

export type ProviderStateLocatorOwnershipPredicate = (
  locatorJson: string,
  database: Database,
) => boolean;

function requireText(value: string, field: string): string {
  if (!value.trim()) throw new Error(`${field} must be non-empty`);
  return value;
}

function requireTimestamp(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative safe integer`);
  return value;
}

function requirePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive safe integer`);
  return value;
}

function assertPublicationOwnership(
  database: Database,
  options: CreateProviderStateLifecycleOptions,
  attempt: ProviderStateLifecycleAttemptBinding,
  now: number,
): void {
  const session = database
    .prepare("SELECT lifecycle_generation FROM sessions WHERE session_key = ?")
    .get(options.sessionKey) as OwnedSessionRow | undefined;
  const attemptRow = database
    .prepare(
      `SELECT status, session_key, provider, boot_epoch, lease_expires_at
       FROM runtime_turn_attempts WHERE attempt_id = ?`,
    )
    .get(attempt.attemptId) as OwnedAttemptRow | undefined;
  if (
    !session ||
    session.lifecycle_generation !== options.admittedEpoch ||
    !attemptRow ||
    attemptRow.status !== "running" ||
    attemptRow.session_key !== options.sessionKey ||
    attemptRow.provider !== options.provider ||
    attemptRow.boot_epoch !== attempt.bootEpoch ||
    !Number.isSafeInteger(attemptRow.lease_expires_at) ||
    attemptRow.lease_expires_at <= now
  ) {
    throw new ProviderStateLifecycleOwnershipError();
  }
}

function assertWithinPublishDeadline(startedAt: number, observedAt: number, deadlineMs: number): void {
  requireTimestamp(observedAt, "host clock");
  if (observedAt < startedAt || observedAt - startedAt > deadlineMs) {
    throw new Error("Provider state publication callback exceeded its host deadline");
  }
}

function reconcileAttemptIsValid(attempt: OwnedAttemptRow | undefined): attempt is OwnedAttemptRow {
  return Boolean(
    attempt &&
      typeof attempt.session_key === "string" &&
      attempt.session_key.trim() &&
      typeof attempt.provider === "string" &&
      attempt.provider.trim() &&
      typeof attempt.boot_epoch === "string" &&
      attempt.boot_epoch.trim() &&
      (RECONCILABLE_ATTEMPT_STATUSES as readonly string[]).includes(attempt.status) &&
      Number.isSafeInteger(attempt.lease_expires_at) &&
      attempt.lease_expires_at >= 0,
  );
}

export function createProviderStateLifecycle(
  options: CreateProviderStateLifecycleOptions,
): RuntimeProviderStateLifecycle {
  requireText(options.provider, "provider");
  requireText(options.sessionKey, "sessionKey");
  if (!Number.isSafeInteger(options.admittedEpoch) || options.admittedEpoch < 1) {
    throw new Error("admittedEpoch must be a positive safe integer");
  }
  const database = options.database ?? getDb();
  const now = options.now ?? Date.now;
  const publishDeadlineMs = requirePositiveInteger(
    options.publishDeadlineMs ?? DEFAULT_PUBLISH_DEADLINE_MS,
    "publishDeadlineMs",
  );

  const reservations = new Map<string, ProviderStateLifecycleAttemptBinding>();
  return Object.freeze({
    reservePreparedState() {
      const attempt = options.currentAttempt();
      if (!attempt) throw new ProviderStateLifecycleOwnershipError();
      requireText(attempt.attemptId, "attemptId");
      requireText(attempt.bootEpoch, "bootEpoch");
      const reservationId = `cleanup_${randomUUID()}`;
      reservations.set(reservationId, { ...attempt });
      return { reservationId, ownerAttemptId: attempt.attemptId };
    },
    publishPreparedState(input: RuntimeProviderStatePublishInput) {
      const attempt = options.currentAttempt();
      if (!attempt) throw new ProviderStateLifecycleOwnershipError();
      requireText(attempt.attemptId, "attemptId");
      requireText(attempt.bootEpoch, "bootEpoch");
      const reservationId = requireText(input.reservationId, "reservationId");
      const reserved = reservations.get(reservationId);
      if (!reserved || reserved.attemptId !== attempt.attemptId || reserved.bootEpoch !== attempt.bootEpoch) {
        throw new ProviderStateLifecycleOwnershipError();
      }
      const locator = parseProviderStateCleanupLocator(serializeProviderStateCleanupLocator(input.locator));
      if (locator.provider !== options.provider) {
        throw new Error("Provider cleanup locator does not match the scoped lifecycle provider");
      }
      const startedAt = requireTimestamp(now(), "host clock");
      try {
        return executeWrite(
          database,
          (transaction) => {
            assertPublicationOwnership(transaction, options, attempt, startedAt);
            enqueuePreparedProviderStateCleanupTaskInTransaction(transaction, {
              id: reservationId,
              locator,
              owner: {
                attemptId: attempt.attemptId,
                sessionKey: options.sessionKey,
                bootEpoch: attempt.bootEpoch,
              },
              now: startedAt,
            });
            assertWithinPublishDeadline(startedAt, now(), publishDeadlineMs);
            // JavaScript cannot preempt a synchronous callback. Providers must
            // therefore use bounded primitives; the post-check fails closed and
            // rolls back the SQLite reservation if that bound is exceeded.
            const callbackResult = input.publish();
            if (callbackResult !== undefined) {
              throw new Error("Provider state publication callback must be synchronous and return void");
            }
            const finishedAt = now();
            assertWithinPublishDeadline(startedAt, finishedAt, publishDeadlineMs);
            assertPublicationOwnership(transaction, options, attempt, finishedAt);
            const published = publishPreparedProviderStateCleanupTaskInTransaction(transaction, {
              id: reservationId,
              locator,
              owner: {
                attemptId: attempt.attemptId,
                sessionKey: options.sessionKey,
                bootEpoch: attempt.bootEpoch,
              },
              now: finishedAt,
            });
            if (!published) throw new ProviderStateLifecycleOwnershipError();
            return { reservationId };
          },
          { label: "provider-state-publish-prepared" },
        );
      } finally {
        reservations.delete(reservationId);
      }
    },
  });
}

export interface AdoptPublishedProviderStateInput {
  session: SessionProviderStateOwnership;
  provider: string;
  providerSessionId: string;
  nextSession: { params?: Record<string, unknown> | null; displayId?: string | null };
  reservationId: string;
  ownerAttemptId: string;
  ownerBootEpoch: string;
  now?: number;
  database?: Database;
}

function runtimeSessionJson(params: Record<string, unknown> | null | undefined): string | null {
  return params && Object.keys(params).length > 0 ? JSON.stringify(params) : null;
}

function sameLocatorLineage(
  previous: ReturnType<typeof parseProviderStateCleanupLocator>,
  next: ReturnType<typeof parseProviderStateCleanupLocator>,
): boolean {
  return (
    previous.provider === next.provider &&
    previous.model === next.model &&
    previous.sessionId === next.sessionId &&
    previous.cwd === next.cwd &&
    previous.workspaceIdentity.realpath === next.workspaceIdentity.realpath &&
    previous.workspaceIdentity.device === next.workspaceIdentity.device &&
    previous.workspaceIdentity.inode === next.workspaceIdentity.inode &&
    next.revision > previous.revision
  );
}

/** Atomically adopts a published provider locator and consumes its cleanup reservation. */
export function adoptPublishedProviderState(
  input: AdoptPublishedProviderStateInput,
): SessionProviderStateMutationResult {
  const database = input.database ?? getDb();
  const observedLifecycleGeneration = input.session.lifecycleGeneration;
  if (
    typeof observedLifecycleGeneration !== "number" ||
    !Number.isSafeInteger(observedLifecycleGeneration) ||
    observedLifecycleGeneration < 1
  ) {
    return { won: false, lifecycleGeneration: null };
  }
  const lifecycleGeneration = observedLifecycleGeneration;
  const now = requireTimestamp(input.now ?? Date.now(), "now");
  const provider = requireText(input.provider, "provider");
  const providerSessionId = requireText(input.providerSessionId, "providerSessionId");
  const reservationId = requireText(input.reservationId, "reservationId");
  const ownerAttemptId = requireText(input.ownerAttemptId, "ownerAttemptId");
  const ownerBootEpoch = requireText(input.ownerBootEpoch, "ownerBootEpoch");
  const nextLocatorJson = serializeProviderStateCleanupLocator(input.nextSession.params);
  const nextLocator = parseProviderStateCleanupLocator(nextLocatorJson);
  if (nextLocator.provider !== provider || nextLocator.sessionId !== providerSessionId) {
    throw new Error("Provider state adoption locator does not match its provider session");
  }
  const nextSessionJson = runtimeSessionJson(input.nextSession.params);
  const nextDisplayId = input.nextSession.displayId ?? providerSessionId;
  let previousLocatorJson: string | null = null;
  let previousLocator: ReturnType<typeof parseProviderStateCleanupLocator> | null = null;
  if (input.session.runtimeSessionParams) {
    try {
      previousLocatorJson = serializeProviderStateCleanupLocator(input.session.runtimeSessionParams);
      previousLocator = parseProviderStateCleanupLocator(previousLocatorJson);
    } catch {
      previousLocatorJson = null;
      previousLocator = null;
    }
  }

  try {
    return executeWrite(
      database,
      (transaction) => {
        const attempt = transaction
          .prepare(
            `SELECT status, session_key, provider, boot_epoch, lease_expires_at
             FROM runtime_turn_attempts WHERE attempt_id = ?`,
          )
          .get(ownerAttemptId) as OwnedAttemptRow | undefined;
        const task = transaction
          .prepare(
            `SELECT id FROM provider_state_cleanup_tasks
             WHERE id = ? AND provider = ? AND operation = 'provisional_exact'
               AND status = 'published' AND locator_json = ?
               AND owner_attempt_id = ? AND owner_session_key = ? AND owner_boot_epoch = ?`,
          )
          .get(
            reservationId,
            provider,
            nextLocatorJson,
            ownerAttemptId,
            input.session.sessionKey,
            ownerBootEpoch,
          );
        if (
          !task ||
          !attempt ||
          attempt.status !== "running" ||
          attempt.session_key !== input.session.sessionKey ||
          attempt.provider !== provider ||
          attempt.boot_epoch !== ownerBootEpoch ||
          !Number.isSafeInteger(attempt.lease_expires_at) ||
          attempt.lease_expires_at <= now
        ) {
          throw PROVIDER_STATE_ADOPTION_LOST;
        }
        const updated = transaction
          .prepare(
            `UPDATE sessions SET sdk_session_id = ?, runtime_provider = ?, runtime_session_json = ?,
               runtime_session_display_id = ?, updated_at = ?
             WHERE session_key = ? AND lifecycle_generation = ?
               AND sdk_session_id IS ? AND runtime_session_display_id IS ? AND runtime_session_json IS ?`,
          )
          .run(
            providerSessionId,
            provider,
            nextSessionJson,
            nextDisplayId,
            now,
            input.session.sessionKey,
            lifecycleGeneration,
            input.session.sdkSessionId ?? null,
            input.session.runtimeSessionDisplayId ?? null,
            runtimeSessionJson(input.session.runtimeSessionParams),
          );
        if (updated.changes !== 1) throw PROVIDER_STATE_ADOPTION_LOST;
        const consumed = transaction
          .prepare(
            `DELETE FROM provider_state_cleanup_tasks
             WHERE id = ? AND status = 'published' AND operation = 'provisional_exact'
               AND locator_json = ? AND owner_attempt_id = ? AND owner_session_key = ? AND owner_boot_epoch = ?`,
          )
          .run(
            reservationId,
            nextLocatorJson,
            ownerAttemptId,
            input.session.sessionKey,
            ownerBootEpoch,
          );
        if (consumed.changes !== 1) throw PROVIDER_STATE_ADOPTION_LOST;
        if (previousLocator && previousLocatorJson && sameLocatorLineage(previousLocator, nextLocator)) {
          enqueuePublishedProviderStateCleanupTaskInTransaction(transaction, {
            operation: "retire_revision",
            locator: previousLocator,
            successorLocator: nextLocator,
            now,
          });
        }
        return { won: true as const, lifecycleGeneration: Number(lifecycleGeneration) };
      },
      { label: "provider-state-adopt-published" },
    );
  } catch (error) {
    if (error !== PROVIDER_STATE_ADOPTION_LOST) throw error;
    const row = database
      .prepare("SELECT lifecycle_generation FROM sessions WHERE session_key = ?")
      .get(input.session.sessionKey) as { lifecycle_generation: number } | undefined;
    return { won: false, lifecycleGeneration: row?.lifecycle_generation ?? null };
  }
}

/** Reconcile one already-validated provider intent under a single writer lock. */
export function reconcileProviderStatePublishIntent(input: {
  provider: string;
  intent: ProviderStatePublishIntent;
  isLocatorOwned: ProviderStateLocatorOwnershipPredicate;
  now?: number;
  database?: Database;
}): ProviderStatePublishIntentReconcileDecision {
  const database = input.database ?? getDb();
  requireText(input.provider, "provider");
  const now = requireTimestamp(input.now ?? Date.now(), "now");
  const locator = parseProviderStateCleanupLocator(input.intent.locatorJson);
  if (locator.provider !== input.provider) {
    throw new Error("Provider cleanup intent does not match the scoped reconciler provider");
  }
  return executeWrite(
    database,
    (transaction) => {
      const existing = transaction
        .prepare(
          `SELECT id FROM provider_state_cleanup_tasks
           WHERE id = ? AND provider = ? AND operation = 'provisional_exact'
             AND locator_json = ? AND owner_attempt_id = ?
             AND owner_session_key IS NOT NULL AND length(owner_session_key) > 0
             AND owner_boot_epoch IS NOT NULL AND length(owner_boot_epoch) > 0
             AND status IN ('published','leased','failed','dead')`,
        )
        .get(input.intent.taskId, input.provider, input.intent.locatorJson, input.intent.ownerAttemptId);
      if (existing) return "held_existing_task";
      const attempt = transaction
        .prepare(
          `SELECT status, session_key, provider, boot_epoch, lease_expires_at
           FROM runtime_turn_attempts WHERE attempt_id = ?`,
        )
        .get(input.intent.ownerAttemptId) as OwnedAttemptRow | undefined;
      if (!reconcileAttemptIsValid(attempt) || attempt.provider !== input.provider) {
        const evidence = recordInvalidProviderStatePublishIntentInTransaction(transaction, {
          taskId: input.intent.taskId,
          provider: input.provider,
          locatorJson: input.intent.locatorJson,
          ownerAttemptId: input.intent.ownerAttemptId,
          errorCode: !attempt ? "state_missing" : reconcileAttemptIsValid(attempt) ? "binding_mismatch" : "schema_mismatch",
          now,
        });
        return evidence.id === input.intent.taskId && evidence.ownerAttemptId === input.intent.ownerAttemptId
          ? "held_invalid_attempt"
          : "held_existing_task";
      }
      if (attempt.status === "running" && attempt.lease_expires_at > now) return "held_active_attempt";
      if (input.isLocatorOwned(input.intent.locatorJson, transaction)) {
        return "remove_owned_intent";
      }
      const owner = {
        attemptId: input.intent.ownerAttemptId,
        sessionKey: attempt.session_key,
        bootEpoch: attempt.boot_epoch,
      };
      enqueuePreparedProviderStateCleanupTaskInTransaction(transaction, {
        id: input.intent.taskId,
        locator,
        owner,
        now,
      });
      const published = publishPreparedProviderStateCleanupTaskInTransaction(transaction, {
        id: input.intent.taskId,
        locator,
        owner,
        now,
      });
      if (!published) throw new ProviderStateLifecycleOwnershipError();
      return "published_cleanup";
    },
    { label: "provider-state-intent-reconcile" },
  );
}
