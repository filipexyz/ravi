import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { executeWrite } from "../db/write-retry.js";
import { getDb } from "../router/router-db.js";

const CLEANUP_SCHEMA_VERSION = 1 as const;
const MAX_CANONICAL_LOCATOR_BYTES = 16 * 1024;
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_BASE_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 5 * 60_000;
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

export function enqueuePreparedProviderStateCleanupTask(
  input: EnqueuePreparedProviderStateCleanupTaskInput,
): ProviderStateCleanupTask {
  const prepared = preparePreparedInput(input);
  return executeWrite(getDb(), (database) => insertTask(database, prepared), {
    label: "provider-state-cleanup-enqueue-prepared",
  });
}

export function enqueuePublishedProviderStateCleanupTask(
  input: EnqueuePublishedProviderStateCleanupTaskInput,
): ProviderStateCleanupTask {
  const prepared = preparePublishedInput(input);
  return executeWrite(getDb(), (database) => insertTask(database, prepared), {
    label: "provider-state-cleanup-enqueue-published",
  });
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
  lease_expires_at: unknown;
}

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
      `SELECT session_key, provider, boot_epoch, status, lease_expires_at
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
    typeof attempt.lease_expires_at !== "number" ||
    !Number.isSafeInteger(attempt.lease_expires_at) ||
    attempt.lease_expires_at < 0
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
  leaseDurationMs: number;
}): ProviderStateCleanupTask[] {
  const now = requireTimestamp(input.now ?? Date.now(), "now");
  if (!Number.isSafeInteger(input.limit) || input.limit < 1) throw new Error("limit must be a positive safe integer");
  if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs < 1) {
    throw new Error("leaseDurationMs must be a positive safe integer");
  }
  const leasedUntil = requireTimestamp(now + input.leaseDurationMs, "leasedUntil");
  return executeWrite(
    getDb(),
    (database) => {
      const candidates = database
        .prepare(
          `SELECT * FROM provider_state_cleanup_tasks
           WHERE (
             (status IN ('published','failed') AND next_attempt_at <= ?)
             OR (status = 'leased' AND leased_until <= ?)
           )
           ORDER BY created_at, id`,
        )
        .all(now, now) as CleanupTaskRow[];
      const claimed: ProviderStateCleanupTask[] = [];
      for (const task of candidates) {
        if (claimed.length >= input.limit) break;
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

export function failProviderStateCleanupTask(input: {
  id: string;
  leaseId: string;
  errorCode: ProviderStateCleanupErrorCode;
  retryable: boolean;
  now?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  maxAttempts?: number;
}): boolean {
  const now = requireTimestamp(input.now ?? Date.now(), "now");
  if (!(PROVIDER_STATE_CLEANUP_ERROR_CODES as readonly string[]).includes(input.errorCode)) {
    throw new Error("Provider cleanup error code is not allowlisted");
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
      const willRetry = input.retryable && task.attempt_count < maxAttempts;
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
