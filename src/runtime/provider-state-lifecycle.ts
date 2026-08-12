import type { Database } from "bun:sqlite";
import { executeWrite } from "../db/write-retry.js";
import { getDb } from "../router/router-db.js";
import {
  enqueuePreparedProviderStateCleanupTaskInTransaction,
  publishPreparedProviderStateCleanupTaskInTransaction,
  parseProviderStateCleanupLocator,
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
}

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
  | "held_existing_task"
  | "remove_owned_intent"
  | "published_cleanup";

interface OwnedSessionRow {
  lifecycle_generation: number;
}

interface OwnedAttemptRow {
  status: string;
  session_key: string;
  provider: string;
  boot_epoch: string;
}

interface ReconcileAttemptRow extends OwnedAttemptRow {
  lease_expires_at: number;
}

function requireText(value: string, field: string): string {
  if (!value.trim()) throw new Error(`${field} must be non-empty`);
  return value;
}

function assertPublicationOwnership(
  database: Database,
  options: CreateProviderStateLifecycleOptions,
  attempt: ProviderStateLifecycleAttemptBinding,
): void {
  const session = database
    .prepare("SELECT lifecycle_generation FROM sessions WHERE session_key = ?")
    .get(options.sessionKey) as OwnedSessionRow | undefined;
  const attemptRow = database
    .prepare(
      `SELECT status, session_key, provider, boot_epoch
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
    attemptRow.boot_epoch !== attempt.bootEpoch
  ) {
    throw new ProviderStateLifecycleOwnershipError();
  }
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

  return Object.freeze({
    publishPreparedState(input: RuntimeProviderStatePublishInput) {
      const attempt = options.currentAttempt();
      if (!attempt) throw new ProviderStateLifecycleOwnershipError();
      requireText(attempt.attemptId, "attemptId");
      requireText(attempt.bootEpoch, "bootEpoch");
      const reservationId = requireText(input.reservationId, "reservationId");
      const now = input.now ?? Date.now();
      return executeWrite(
        database,
        (transaction) => {
          assertPublicationOwnership(transaction, options, attempt);
          enqueuePreparedProviderStateCleanupTaskInTransaction(transaction, {
            id: reservationId,
            locator: input.locator,
            owner: {
              attemptId: attempt.attemptId,
              sessionKey: options.sessionKey,
              bootEpoch: attempt.bootEpoch,
            },
            now,
          });
          const callbackResult = input.publish();
          if (callbackResult !== undefined) {
            throw new Error("Provider state publication callback must be synchronous and return void");
          }
          const published = publishPreparedProviderStateCleanupTaskInTransaction(transaction, {
            id: reservationId,
            locator: input.locator,
            owner: {
              attemptId: attempt.attemptId,
              sessionKey: options.sessionKey,
              bootEpoch: attempt.bootEpoch,
            },
            now,
          });
          if (!published) throw new ProviderStateLifecycleOwnershipError();
          return { reservationId };
        },
        { label: "provider-state-publish-prepared" },
      );
    },
  });
}

export function isProviderStateLocatorOwned(locatorJson: string, database: Database = getDb()): boolean {
  const provider = parseProviderStateCleanupLocator(locatorJson).provider;
  const rows = database
    .prepare("SELECT runtime_session_json FROM sessions WHERE runtime_provider = ? AND runtime_session_json IS NOT NULL")
    .all(provider) as Array<{ runtime_session_json: string }>;
  return rows.some((row) => {
    try {
      return serializeProviderStateCleanupLocator(JSON.parse(row.runtime_session_json)) === locatorJson;
    } catch {
      return false;
    }
  });
}

/** Reconcile one already-validated provider intent under a single writer lock. */
export function reconcileProviderStatePublishIntent(input: {
  intent: ProviderStatePublishIntent;
  now?: number;
  database?: Database;
}): ProviderStatePublishIntentReconcileDecision {
  const database = input.database ?? getDb();
  const now = input.now ?? Date.now();
  const locator = parseProviderStateCleanupLocator(input.intent.locatorJson);
  return executeWrite(
    database,
    (transaction) => {
      const attempt = transaction
        .prepare(
          `SELECT status, session_key, provider, boot_epoch, lease_expires_at
           FROM runtime_turn_attempts WHERE attempt_id = ?`,
        )
        .get(input.intent.ownerAttemptId) as ReconcileAttemptRow | undefined;
      if (
        !attempt ||
        !attempt.session_key ||
        attempt.provider !== locator.provider ||
        !attempt.boot_epoch
      ) {
        throw new ProviderStateLifecycleOwnershipError();
      }
      const existing = transaction
        .prepare(
          `SELECT id FROM provider_state_cleanup_tasks
           WHERE id = ? AND provider = ? AND operation = 'provisional_exact'
             AND locator_json = ? AND owner_attempt_id = ? AND owner_session_key = ?
             AND owner_boot_epoch = ?`,
        )
        .get(
          input.intent.taskId,
          locator.provider,
          input.intent.locatorJson,
          input.intent.ownerAttemptId,
          attempt.session_key,
          attempt.boot_epoch,
        );
      if (existing) return "held_existing_task";
      if (attempt.status === "running" && attempt.lease_expires_at > now) return "held_active_attempt";
      if (isProviderStateLocatorOwned(input.intent.locatorJson, transaction)) {
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
