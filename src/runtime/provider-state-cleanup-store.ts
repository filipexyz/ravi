import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { executeWrite } from "../db/write-retry.js";
import { getDb } from "../router/router-db.js";

const CLEANUP_SCHEMA_VERSION = 1 as const;
const MAX_CANONICAL_LOCATOR_BYTES = 16 * 1024;
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_BASE_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 5 * 60_000;
const DEFAULT_EXECUTOR_UNAVAILABLE_DELAY_MS = 10_000;
const DEFAULT_CLAIM_SCAN_FACTOR = 4;
const MAX_CLAIM_SCAN_LIMIT = 256;
const SESSION_MUTATION_LOST = Symbol("provider-state-cleanup-session-mutation-lost");
const RUNTIME_TURN_ATTEMPT_STATUSES = ["running", "complete", "failed", "interrupted", "timeout", "aborted"] as const;

const LOCATOR_KEYS = [
  "schemaVersion",
  "provider",
  "model",
  "sessionId",
  "revision",
  "cwd",
  "workspaceIdentity",
  "sessionFile",
  "lastCommittedTurnId",
] as const;
const WORKSPACE_IDENTITY_KEYS = ["realpath", "device", "inode"] as const;

export const PROVIDER_STATE_CLEANUP_ERROR_CODES = [
  "state_missing",
  "io_transient",
  "state_busy",
  "invalid_locator",
  "schema_mismatch",
  "binding_mismatch",
  "foreign_root",
  "reparse_detected",
  "credential_detected",
  "executor_unavailable",
  "unknown",
] as const;

export type ProviderStateCleanupErrorCode = (typeof PROVIDER_STATE_CLEANUP_ERROR_CODES)[number];
export type ProviderStateCleanupOperation = "provisional_exact" | "delete_state" | "retire_revision";
export type ProviderStateCleanupStatus = "prepared" | "published" | "leased" | "failed" | "dead";

export interface ProviderStateCleanupLocator {
  schemaVersion: typeof CLEANUP_SCHEMA_VERSION;
  provider: string;
  model: string;
  sessionId: string;
  revision: number;
  cwd: string;
  workspaceIdentity: {
    realpath: string;
    device: string;
    inode: string;
  };
  sessionFile: string;
  lastCommittedTurnId: string;
}

export interface ProviderStateCleanupOwner {
  attemptId: string;
  sessionKey: string;
  bootEpoch: string;
}

export interface ProviderStateCleanupTask {
  id: string;
  idempotencyKey: string;
  schemaVersion: number;
  provider: string;
  operation: ProviderStateCleanupOperation;
  locatorJson: string;
  successorLocatorJson: string | null;
  status: ProviderStateCleanupStatus;
  ownerAttemptId: string | null;
  ownerSessionKey: string | null;
  ownerBootEpoch: string | null;
  attemptCount: number;
  nextAttemptAt: number;
  leaseId: string | null;
  leasedUntil: number | null;
  lastErrorCode: ProviderStateCleanupErrorCode | null;
  createdAt: number;
  updatedAt: number;
}

interface CleanupTaskRow {
  id: string;
  idempotency_key: string;
  schema_version: number;
  provider: string;
  operation: ProviderStateCleanupOperation;
  locator_json: string;
  successor_locator_json: string | null;
  status: ProviderStateCleanupStatus;
  owner_attempt_id: string | null;
  owner_session_key: string | null;
  owner_boot_epoch: string | null;
  attempt_count: number;
  next_attempt_at: number;
  lease_id: string | null;
  leased_until: number | null;
  last_error_code: ProviderStateCleanupErrorCode | null;
  created_at: number;
  updated_at: number;
}

export interface EnqueuePreparedProviderStateCleanupTaskInput {
  id?: string;
  locator: unknown;
  owner: ProviderStateCleanupOwner;
  now?: number;
}

export interface EnqueuePublishedProviderStateCleanupTaskInput {
  id?: string;
  operation: Exclude<ProviderStateCleanupOperation, "provisional_exact">;
  locator: unknown;
  successorLocator?: unknown;
  now?: number;
}

export interface PublishPreparedProviderStateCleanupTaskInput {
  id: string;
  locator: unknown;
  owner: ProviderStateCleanupOwner;
  now?: number;
}

export interface RecordInvalidProviderStatePublishIntentInput {
  taskId: string;
  provider: string;
  locatorJson: string;
  ownerAttemptId: string;
  errorCode: "state_missing" | "schema_mismatch" | "binding_mismatch";
  now?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Provider cleanup locator ${field} must be a non-empty string`);
  }
  return value;
}

function requireTimestamp(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative safe integer`);
  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Provider cleanup locator ${field} must be a positive safe integer`);
  }
  return value;
}

function projectProviderStateCleanupLocator(value: unknown): ProviderStateCleanupLocator {
  if (!isRecord(value)) throw new Error("Provider cleanup locator must be an object");
  if (value.schemaVersion !== CLEANUP_SCHEMA_VERSION) {
    throw new Error(`Provider cleanup locator schemaVersion must be ${CLEANUP_SCHEMA_VERSION}`);
  }
  if (!isRecord(value.workspaceIdentity) || !hasExactKeys(value.workspaceIdentity, WORKSPACE_IDENTITY_KEYS)) {
    throw new Error("Provider cleanup locator workspaceIdentity is invalid");
  }
  return {
    schemaVersion: CLEANUP_SCHEMA_VERSION,
    provider: requireNonEmptyString(value.provider, "provider"),
    model: requireNonEmptyString(value.model, "model"),
    sessionId: requireNonEmptyString(value.sessionId, "sessionId"),
    revision: requirePositiveInteger(value.revision, "revision"),
    cwd: requireNonEmptyString(value.cwd, "cwd"),
    workspaceIdentity: {
      realpath: requireNonEmptyString(value.workspaceIdentity.realpath, "workspaceIdentity.realpath"),
      device: requireNonEmptyString(value.workspaceIdentity.device, "workspaceIdentity.device"),
      inode: requireNonEmptyString(value.workspaceIdentity.inode, "workspaceIdentity.inode"),
    },
    sessionFile: requireNonEmptyString(value.sessionFile, "sessionFile"),
    lastCommittedTurnId: requireNonEmptyString(value.lastCommittedTurnId, "lastCommittedTurnId"),
  };
}

export function serializeProviderStateCleanupLocator(value: unknown): string {
  const canonical = JSON.stringify(projectProviderStateCleanupLocator(value));
  if (Buffer.byteLength(canonical, "utf8") > MAX_CANONICAL_LOCATOR_BYTES) {
    throw new Error("Provider cleanup locator exceeds the 16 KiB canonical payload limit");
  }
  return canonical;
}

export function parseProviderStateCleanupLocator(serialized: string): ProviderStateCleanupLocator {
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > MAX_CANONICAL_LOCATOR_BYTES) {
    throw new Error("Provider cleanup locator exceeds the 16 KiB canonical payload limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error("Provider cleanup locator is not valid JSON");
  }
  if (!isRecord(parsed) || !hasExactKeys(parsed, LOCATOR_KEYS)) {
    throw new Error("Provider cleanup locator contains missing or unknown fields");
  }
  const locator = projectProviderStateCleanupLocator(parsed);
  if (JSON.stringify(locator) !== serialized) throw new Error("Provider cleanup locator is not canonical JSON");
  return locator;
}

export function createProviderStateCleanupIdempotencyKey(
  operation: ProviderStateCleanupOperation,
  locatorJson: string,
  successorLocatorJson: string | null,
): string {
  const locator = parseProviderStateCleanupLocator(locatorJson);
  if (operation === "retire_revision") {
    if (successorLocatorJson === null) throw new Error("Retirement cleanup requires a successor locator");
    parseProviderStateCleanupLocator(successorLocatorJson);
  } else if (successorLocatorJson !== null) {
    throw new Error(`${operation} cleanup must not have a successor locator`);
  }
  return createHash("sha256")
    .update(String(CLEANUP_SCHEMA_VERSION), "utf8")
    .update("\0", "utf8")
    .update(locator.provider, "utf8")
    .update("\0", "utf8")
    .update(operation, "utf8")
    .update("\0", "utf8")
    .update(locatorJson, "utf8")
    .update("\0", "utf8")
    .update(successorLocatorJson === null ? "<null>" : successorLocatorJson, "utf8")
    .digest("hex");
}

function rowToTask(row: CleanupTaskRow): ProviderStateCleanupTask {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    schemaVersion: row.schema_version,
    provider: row.provider,
    operation: row.operation,
    locatorJson: row.locator_json,
    successorLocatorJson: row.successor_locator_json,
    status: row.status,
    ownerAttemptId: row.owner_attempt_id,
    ownerSessionKey: row.owner_session_key,
    ownerBootEpoch: row.owner_boot_epoch,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    leaseId: row.lease_id,
    leasedUntil: row.leased_until,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getTaskByIdempotencyKey(database: Database, idempotencyKey: string): CleanupTaskRow | null {
  return (
    (database.prepare("SELECT * FROM provider_state_cleanup_tasks WHERE idempotency_key = ?").get(idempotencyKey) as
      | CleanupTaskRow
      | undefined) ?? null
  );
}

function insertTask(
  database: Database,
  input: {
    id?: string;
    operation: ProviderStateCleanupOperation;
    locatorJson: string;
    successorLocatorJson: string | null;
    status: "prepared" | "published";
    owner: ProviderStateCleanupOwner | null;
    now: number;
  },
): ProviderStateCleanupTask {
  const locator = parseProviderStateCleanupLocator(input.locatorJson);
  const idempotencyKey = createProviderStateCleanupIdempotencyKey(
    input.operation,
    input.locatorJson,
    input.successorLocatorJson,
  );
  const id = input.id ?? `cleanup_${randomUUID()}`;
  database
    .prepare(
      `INSERT OR IGNORE INTO provider_state_cleanup_tasks (
        id, idempotency_key, schema_version, provider, operation, locator_json,
        successor_locator_json, status, owner_attempt_id, owner_session_key,
        owner_boot_epoch, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      idempotencyKey,
      CLEANUP_SCHEMA_VERSION,
      locator.provider,
      input.operation,
      input.locatorJson,
      input.successorLocatorJson,
      input.status,
      input.owner?.attemptId ?? null,
      input.owner?.sessionKey ?? null,
      input.owner?.bootEpoch ?? null,
      input.now,
      input.now,
    );
  const row = getTaskByIdempotencyKey(database, idempotencyKey);
  if (!row) throw new Error("Provider cleanup task insert did not produce a durable row");
  const matches =
    (input.id === undefined || row.id === input.id) &&
    row.schema_version === CLEANUP_SCHEMA_VERSION &&
    row.provider === locator.provider &&
    row.operation === input.operation &&
    row.locator_json === input.locatorJson &&
    row.successor_locator_json === input.successorLocatorJson &&
    row.owner_attempt_id === (input.owner?.attemptId ?? null) &&
    row.owner_session_key === (input.owner?.sessionKey ?? null) &&
    row.owner_boot_epoch === (input.owner?.bootEpoch ?? null);
  if (!matches) throw new Error("Provider cleanup idempotency key conflicts with different immutable task data");
  return rowToTask(row);
}

function preparePreparedInput(input: EnqueuePreparedProviderStateCleanupTaskInput) {
  const now = requireTimestamp(input.now ?? Date.now(), "now");
  const owner = {
    attemptId: requireNonEmptyString(input.owner.attemptId, "owner.attemptId"),
    sessionKey: requireNonEmptyString(input.owner.sessionKey, "owner.sessionKey"),
    bootEpoch: requireNonEmptyString(input.owner.bootEpoch, "owner.bootEpoch"),
  };
  return {
    id: input.id,
    operation: "provisional_exact" as const,
    locatorJson: serializeProviderStateCleanupLocator(input.locator),
    successorLocatorJson: null,
    status: "prepared" as const,
    owner,
    now,
  };
}

function preparePublishedInput(input: EnqueuePublishedProviderStateCleanupTaskInput) {
  const now = requireTimestamp(input.now ?? Date.now(), "now");
  const successorLocatorJson =
    input.operation === "retire_revision"
      ? serializeProviderStateCleanupLocator(input.successorLocator)
      : input.successorLocator === undefined
        ? null
        : (() => {
            throw new Error(`${input.operation} cleanup must not have a successor locator`);
          })();
  return {
    id: input.id,
    operation: input.operation,
    locatorJson: serializeProviderStateCleanupLocator(input.locator),
    successorLocatorJson,
    status: "published" as const,
    owner: null,
    now,
  };
}

function preparePublishInput(input: PublishPreparedProviderStateCleanupTaskInput) {
  return {
    id: requireNonEmptyString(input.id, "id"),
    locatorJson: serializeProviderStateCleanupLocator(input.locator),
    owner: {
      attemptId: requireNonEmptyString(input.owner.attemptId, "owner.attemptId"),
      sessionKey: requireNonEmptyString(input.owner.sessionKey, "owner.sessionKey"),
      bootEpoch: requireNonEmptyString(input.owner.bootEpoch, "owner.bootEpoch"),
    },
    now: requireTimestamp(input.now ?? Date.now(), "now"),
  };
}

export function enqueuePreparedProviderStateCleanupTaskInTransaction(
  database: Database,
  input: EnqueuePreparedProviderStateCleanupTaskInput,
): ProviderStateCleanupTask {
  return insertTask(database, preparePreparedInput(input));
}

export function enqueuePreparedProviderStateCleanupTask(
  input: EnqueuePreparedProviderStateCleanupTaskInput,
): ProviderStateCleanupTask {
  return executeWrite(getDb(), (database) => enqueuePreparedProviderStateCleanupTaskInTransaction(database, input), {
    label: "provider-state-cleanup-enqueue-prepared",
  });
}

export function publishPreparedProviderStateCleanupTaskInTransaction(
  database: Database,
  input: PublishPreparedProviderStateCleanupTaskInput,
): ProviderStateCleanupTask | null {
  const prepared = preparePublishInput(input);
  const result = database
    .prepare(
      `UPDATE provider_state_cleanup_tasks
       SET status = 'published', updated_at = ?
       WHERE id = ? AND schema_version = ? AND operation = 'provisional_exact'
         AND status = 'prepared' AND locator_json = ?
         AND owner_attempt_id = ? AND owner_session_key = ? AND owner_boot_epoch = ?`,
    )
    .run(
      prepared.now,
      prepared.id,
      CLEANUP_SCHEMA_VERSION,
      prepared.locatorJson,
      prepared.owner.attemptId,
      prepared.owner.sessionKey,
      prepared.owner.bootEpoch,
    );
  if (result.changes !== 1) return null;
  const row = database.prepare("SELECT * FROM provider_state_cleanup_tasks WHERE id = ?").get(prepared.id) as
    | CleanupTaskRow
    | undefined;
  if (!row) throw new Error("Published provider cleanup reservation disappeared inside its transaction");
  return rowToTask(row);
}

export function enqueuePublishedProviderStateCleanupTask(
  input: EnqueuePublishedProviderStateCleanupTaskInput,
): ProviderStateCleanupTask {
  return executeWrite(getDb(), (database) => enqueuePublishedProviderStateCleanupTaskInTransaction(database, input), {
    label: "provider-state-cleanup-enqueue-published",
  });
}

export function enqueuePublishedProviderStateCleanupTaskInTransaction(
  database: Database,
  input: EnqueuePublishedProviderStateCleanupTaskInput,
): ProviderStateCleanupTask {
  return insertTask(database, preparePublishedInput(input));
}

export function mutateSessionAndEnqueueProviderStateCleanup(
  input: EnqueuePublishedProviderStateCleanupTaskInput,
  mutateSession: (database: Database) => boolean,
): { won: false; task: null } | { won: true; task: ProviderStateCleanupTask } {
  const prepared = preparePublishedInput(input);
  try {
    return executeWrite(
      getDb(),
      (database) => {
        if (!mutateSession(database)) throw SESSION_MUTATION_LOST;
        return { won: true as const, task: insertTask(database, prepared) };
      },
      { label: "provider-state-cleanup-session-mutation" },
    );
  } catch (error) {
    if (error === SESSION_MUTATION_LOST) return { won: false, task: null };
    throw error;
  }
}

interface AttemptIdentityRow {
  session_key: unknown;
  provider: unknown;
  boot_epoch: unknown;
  status: unknown;
  started_at: unknown;
  last_heartbeat_at: unknown;
  lease_expires_at: unknown;
  completed_at: unknown;
}

interface CleanupClaimScanCursor {
  createdAt: number;
  id: string;
}

const cleanupClaimScanCursors = new WeakMap<Database, CleanupClaimScanCursor>();

function deadLetterInvalidProvisionalOwner(
  database: Database,
  task: CleanupTaskRow,
  errorCode: "state_missing" | "schema_mismatch" | "binding_mismatch",
  now: number,
): void {
  database
    .prepare(
      `UPDATE provider_state_cleanup_tasks
       SET status = 'dead', lease_id = NULL, leased_until = NULL,
         last_error_code = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(errorCode, now, task.id);
}

function provisionalTaskIsClaimable(database: Database, task: CleanupTaskRow, now: number): boolean {
  if (!task.owner_attempt_id || !task.owner_session_key || !task.owner_boot_epoch) {
    deadLetterInvalidProvisionalOwner(database, task, "schema_mismatch", now);
    return false;
  }
  const attempt = database
    .prepare(
      `SELECT session_key, provider, boot_epoch, status, started_at,
         last_heartbeat_at, lease_expires_at, completed_at
       FROM runtime_turn_attempts WHERE attempt_id = ?`,
    )
    .get(task.owner_attempt_id) as AttemptIdentityRow | undefined;
  if (!attempt) {
    deadLetterInvalidProvisionalOwner(database, task, "state_missing", now);
    return false;
  }
  if (
    typeof attempt.session_key !== "string" ||
    typeof attempt.provider !== "string" ||
    typeof attempt.boot_epoch !== "string" ||
    typeof attempt.status !== "string" ||
    !(RUNTIME_TURN_ATTEMPT_STATUSES as readonly string[]).includes(attempt.status) ||
    typeof attempt.started_at !== "number" ||
    !Number.isSafeInteger(attempt.started_at) ||
    attempt.started_at < 0 ||
    typeof attempt.last_heartbeat_at !== "number" ||
    !Number.isSafeInteger(attempt.last_heartbeat_at) ||
    attempt.last_heartbeat_at < attempt.started_at ||
    typeof attempt.lease_expires_at !== "number" ||
    !Number.isSafeInteger(attempt.lease_expires_at) ||
    attempt.lease_expires_at <= attempt.last_heartbeat_at ||
    (attempt.status === "running"
      ? attempt.completed_at !== null
      : typeof attempt.completed_at !== "number" ||
        !Number.isSafeInteger(attempt.completed_at) ||
        attempt.completed_at < attempt.last_heartbeat_at)
  ) {
    deadLetterInvalidProvisionalOwner(database, task, "schema_mismatch", now);
    return false;
  }
  if (
    attempt.session_key !== task.owner_session_key ||
    attempt.provider !== task.provider ||
    attempt.boot_epoch !== task.owner_boot_epoch
  ) {
    deadLetterInvalidProvisionalOwner(database, task, "binding_mismatch", now);
    return false;
  }
  return attempt.status !== "running" || attempt.lease_expires_at <= now;
}

export function claimProviderStateCleanupTasks(input: {
  now?: number;
  limit: number;
  scanLimit?: number;
  leaseDurationMs: number;
}): ProviderStateCleanupTask[] {
  const now = requireTimestamp(input.now ?? Date.now(), "now");
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_CLAIM_SCAN_LIMIT) {
    throw new Error(`limit must be between 1 and ${MAX_CLAIM_SCAN_LIMIT}`);
  }
  const scanLimit = input.scanLimit ?? Math.min(MAX_CLAIM_SCAN_LIMIT, input.limit * DEFAULT_CLAIM_SCAN_FACTOR);
  if (
    !Number.isSafeInteger(scanLimit) ||
    scanLimit < input.limit ||
    scanLimit > MAX_CLAIM_SCAN_LIMIT
  ) {
    throw new Error(`scanLimit must be between limit and ${MAX_CLAIM_SCAN_LIMIT}`);
  }
  if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs < 1) {
    throw new Error("leaseDurationMs must be a positive safe integer");
  }
  const leasedUntil = requireTimestamp(now + input.leaseDurationMs, "leasedUntil");
  return executeWrite(
    getDb(),
    (database) => {
      const readPage = (cursor: CleanupClaimScanCursor | undefined, limit: number): CleanupTaskRow[] =>
        database
          .prepare(
            `SELECT * FROM provider_state_cleanup_tasks
             WHERE (
               (status IN ('published','failed') AND next_attempt_at <= ?)
               OR (status = 'leased' AND leased_until <= ?)
             )
             ${cursor ? "AND (created_at > ? OR (created_at = ? AND id > ?))" : ""}
             ORDER BY created_at, id
             LIMIT ?`,
          )
          .all(
            now,
            now,
            ...(cursor ? [cursor.createdAt, cursor.createdAt, cursor.id] : []),
            limit,
          ) as CleanupTaskRow[];
      let cursor = cleanupClaimScanCursors.get(database);
      let candidates = readPage(cursor, scanLimit);
      if (cursor && candidates.length === 0) {
        cursor = undefined;
        cleanupClaimScanCursors.delete(database);
        candidates = readPage(undefined, scanLimit);
      }
      const claimed: ProviderStateCleanupTask[] = [];
      let remainingScanBudget = scanLimit;
      for (const task of candidates) {
        if (remainingScanBudget <= 0) break;
        remainingScanBudget -= 1;
        cleanupClaimScanCursors.set(database, { createdAt: task.created_at, id: task.id });
        if (task.operation === "provisional_exact" && !provisionalTaskIsClaimable(database, task, now)) continue;
        const leaseId = `cleanup_lease_${randomUUID()}`;
        const result = database
          .prepare(
            `UPDATE provider_state_cleanup_tasks
             SET status = 'leased', attempt_count = attempt_count + 1,
               lease_id = ?, leased_until = ?, last_error_code = NULL, updated_at = ?
             WHERE id = ? AND (
               (status IN ('published','failed') AND next_attempt_at <= ?)
               OR (status = 'leased' AND leased_until <= ?)
             )`,
          )
          .run(leaseId, leasedUntil, now, task.id, now, now);
        if (result.changes !== 1) continue;
        const row = database
          .prepare("SELECT * FROM provider_state_cleanup_tasks WHERE id = ?")
          .get(task.id) as CleanupTaskRow;
        claimed.push(rowToTask(row));
        if (claimed.length >= input.limit) break;
      }
      return claimed;
    },
    { label: "provider-state-cleanup-claim" },
  );
}

export function completeProviderStateCleanupTask(input: { id: string; leaseId: string; now?: number }): boolean {
  const now = requireTimestamp(input.now ?? Date.now(), "now");
  return executeWrite(
    getDb(),
    (database) =>
      database
        .prepare(
          `DELETE FROM provider_state_cleanup_tasks
           WHERE id = ? AND status = 'leased' AND lease_id = ? AND leased_until > ?`,
        )
        .run(input.id, input.leaseId, now).changes === 1,
    { label: "provider-state-cleanup-complete" },
  );
}

export function renewProviderStateCleanupTaskLease(input: {
  id: string;
  leaseId: string;
  leaseDurationMs: number;
  now?: number;
}): boolean {
  const now = requireTimestamp(input.now ?? Date.now(), "now");
  if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs < 1) {
    throw new Error("leaseDurationMs must be a positive safe integer");
  }
  const leasedUntil = requireTimestamp(now + input.leaseDurationMs, "leasedUntil");
  return executeWrite(
    getDb(),
    (database) =>
      database
        .prepare(
          `UPDATE provider_state_cleanup_tasks
           SET leased_until = ?, updated_at = ?
           WHERE id = ? AND status = 'leased' AND lease_id = ? AND leased_until > ?`,
        )
        .run(leasedUntil, now, input.id, input.leaseId, now).changes === 1,
    { label: "provider-state-cleanup-renew-lease" },
  );
}

/** Persist non-claimable evidence for an intent whose owner cannot be trusted. */
export function recordInvalidProviderStatePublishIntent(
  input: RecordInvalidProviderStatePublishIntentInput,
): ProviderStateCleanupTask {
  const now = requireTimestamp(input.now ?? Date.now(), "now");
  const taskId = requireNonEmptyString(input.taskId, "taskId");
  const ownerAttemptId = requireNonEmptyString(input.ownerAttemptId, "ownerAttemptId");
  return executeWrite(
    getDb(),
    (database) =>
      recordInvalidProviderStatePublishIntentInTransaction(database, {
        ...input,
        taskId,
        ownerAttemptId,
        now,
      }),
    { label: "provider-state-cleanup-record-invalid-intent" },
  );
}

export function recordInvalidProviderStatePublishIntentInTransaction(
  database: Database,
  input: RecordInvalidProviderStatePublishIntentInput,
): ProviderStateCleanupTask {
  const now = requireTimestamp(input.now ?? Date.now(), "now");
  const taskId = requireNonEmptyString(input.taskId, "taskId");
  const ownerAttemptId = requireNonEmptyString(input.ownerAttemptId, "ownerAttemptId");
  const locator = parseProviderStateCleanupLocator(input.locatorJson);
  if (locator.provider !== requireNonEmptyString(input.provider, "provider")) {
    throw new Error("Provider cleanup intent evidence does not match its provider");
  }
  const idempotencyKey = createProviderStateCleanupIdempotencyKey("provisional_exact", input.locatorJson, null);
  const existing = getTaskByIdempotencyKey(database, idempotencyKey);
  if (existing) {
    if (
      existing.schema_version !== CLEANUP_SCHEMA_VERSION ||
      existing.provider !== locator.provider ||
      existing.operation !== "provisional_exact" ||
      existing.locator_json !== input.locatorJson ||
      existing.successor_locator_json !== null
    ) {
      throw new Error("Provider cleanup intent evidence conflicts with durable task data");
    }
    return rowToTask(existing);
  }
  database
    .prepare(
      `INSERT OR IGNORE INTO provider_state_cleanup_tasks (
         id, idempotency_key, schema_version, provider, operation, locator_json,
         successor_locator_json, status, owner_attempt_id, owner_session_key,
         owner_boot_epoch, last_error_code, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'provisional_exact', ?, NULL, 'dead', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      taskId,
      idempotencyKey,
      CLEANUP_SCHEMA_VERSION,
      locator.provider,
      input.locatorJson,
      ownerAttemptId,
      "reconciliation-invalid-evidence",
      "reconciliation-invalid-evidence",
      input.errorCode,
      now,
      now,
    );
  const row = getTaskByIdempotencyKey(database, idempotencyKey);
  if (
    !row ||
    row.id !== taskId ||
    row.schema_version !== CLEANUP_SCHEMA_VERSION ||
    row.provider !== locator.provider ||
    row.operation !== "provisional_exact" ||
    row.locator_json !== input.locatorJson ||
    row.successor_locator_json !== null ||
    row.owner_attempt_id !== ownerAttemptId
  ) {
    throw new Error("Provider cleanup intent evidence conflicts with durable task data");
  }
  return rowToTask(row);
}

/**
 * Releases a task whose provider executor is not installed without consuming a
 * retry attempt. The durable diagnostic survives restarts and the task becomes
 * claimable again as soon as a daemon with the executor is installed.
 */
export function holdProviderStateCleanupTaskForUnavailableExecutor(input: {
  id: string;
  leaseId: string;
  now?: number;
  retryDelayMs?: number;
}): boolean {
  const now = requireTimestamp(input.now ?? Date.now(), "now");
  const retryDelayMs = requireTimestamp(
    input.retryDelayMs ?? DEFAULT_EXECUTOR_UNAVAILABLE_DELAY_MS,
    "retryDelayMs",
  );
  if (retryDelayMs < 1) throw new Error("retryDelayMs must be positive");
  const nextAttemptAt = requireTimestamp(now + retryDelayMs, "nextAttemptAt");
  return executeWrite(
    getDb(),
    (database) =>
      database
        .prepare(
          `UPDATE provider_state_cleanup_tasks
           SET status = 'failed', attempt_count = MAX(0, attempt_count - 1),
             next_attempt_at = ?, lease_id = NULL, leased_until = NULL,
             last_error_code = 'executor_unavailable', updated_at = ?
           WHERE id = ? AND status = 'leased' AND lease_id = ? AND leased_until > ?`,
        )
        .run(nextAttemptAt, now, input.id, input.leaseId, now).changes === 1,
    { label: "provider-state-cleanup-hold-executor-unavailable" },
  );
}

function providerStateCleanupFailureDisposition(errorCode: ProviderStateCleanupErrorCode): "retry" | "dead" {
  switch (errorCode) {
    case "io_transient":
    case "state_busy":
    case "executor_unavailable":
      return "retry";
    case "state_missing":
    case "invalid_locator":
    case "schema_mismatch":
    case "binding_mismatch":
    case "foreign_root":
    case "reparse_detected":
    case "credential_detected":
    case "unknown":
      return "dead";
  }
}

export function failProviderStateCleanupTask(input: {
  id: string;
  leaseId: string;
  errorCode: ProviderStateCleanupErrorCode;
  now?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  maxAttempts?: number;
}): boolean {
  const now = requireTimestamp(input.now ?? Date.now(), "now");
  if (!(PROVIDER_STATE_CLEANUP_ERROR_CODES as readonly string[]).includes(input.errorCode)) {
    throw new Error("Provider cleanup error code is not allowlisted");
  }
  if (input.errorCode === "executor_unavailable") {
    return holdProviderStateCleanupTaskForUnavailableExecutor({ id: input.id, leaseId: input.leaseId, now });
  }
  const baseBackoffMs = requireTimestamp(input.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS, "baseBackoffMs");
  const maxBackoffMs = requireTimestamp(input.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS, "maxBackoffMs");
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error("maxAttempts must be positive");
  return executeWrite(
    getDb(),
    (database) => {
      const task = database.prepare("SELECT * FROM provider_state_cleanup_tasks WHERE id = ?").get(input.id) as
        | CleanupTaskRow
        | undefined;
      if (
        !task ||
        task.status !== "leased" ||
        task.lease_id !== input.leaseId ||
        task.leased_until === null ||
        task.leased_until <= now
      ) {
        return false;
      }
      const willRetry =
        providerStateCleanupFailureDisposition(input.errorCode) === "retry" && task.attempt_count < maxAttempts;
      const exponent = Math.max(0, task.attempt_count - 1);
      const delay = Math.min(maxBackoffMs, baseBackoffMs * 2 ** exponent);
      const nextAttemptAt = willRetry ? requireTimestamp(now + delay, "nextAttemptAt") : task.next_attempt_at;
      return (
        database
          .prepare(
            `UPDATE provider_state_cleanup_tasks
             SET status = ?, next_attempt_at = ?, lease_id = NULL, leased_until = NULL,
               last_error_code = ?, updated_at = ?
             WHERE id = ? AND status = 'leased' AND lease_id = ? AND leased_until > ?`,
          )
          .run(willRetry ? "failed" : "dead", nextAttemptAt, input.errorCode, now, input.id, input.leaseId, now)
          .changes === 1
      );
    },
    { label: "provider-state-cleanup-fail" },
  );
}
