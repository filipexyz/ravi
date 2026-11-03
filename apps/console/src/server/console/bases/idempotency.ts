// Idempotency for row writes and for base, property, view, and chart creates
// (SPEC "Idempotency"). The record is reserved inside the write transaction,
// scoped by (organization, source kind, source id, operation, key), and
// stores the request hash and `{ rowIds, versions }` (rows) or
// `{ createdId }` (creates) only.

import { createHash } from "node:crypto";

import { and, eq, lt } from "drizzle-orm";

import { schema } from "@/server/db";
import { BASE_IDEMPOTENCY_KEY_PATTERN, BASES_LIMITS } from "@/shared/bases/limits";

import type { BasesCaller } from "./context";
import { conflict, validationFailed } from "./errors";
import type { BasesExecutor, BasesTx } from "./repository";

export type BaseOperationResult = { rowIds: string[]; versions: number[] };

/** Stored result of an idempotent create: the id of the created object. */
export type BaseCreatedResult = { createdId: string };

export type BaseIdempotencyHashInput = {
  operation: string;
  baseId: string;
  viewId: string | null;
  rowId: string | null;
  values: unknown;
  body: unknown;
  expectedVersion: number | null;
  lastWriteWins: boolean;
};

function stableJson(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

/** sha256 (hex) of the stable JSON of the request; the idempotency key is not part of it. */
export function baseIdempotencyRequestHash(input: BaseIdempotencyHashInput): string {
  return createHash("sha256")
    .update(
      stableJson({
        operation: input.operation,
        baseId: input.baseId,
        viewId: input.viewId,
        rowId: input.rowId,
        values: input.values ?? null,
        body: input.body === undefined ? null : input.body,
        expectedVersion: input.expectedVersion,
        lastWriteWins: input.lastWriteWins,
      }),
    )
    .digest("hex");
}

/** The key from the body or the `Idempotency-Key` header; required, and both must agree when both are sent. */
export function resolveBaseIdempotencyKey(bodyKey: unknown, headerKey: string | null | undefined): string {
  const key = resolveOptionalBaseIdempotencyKey(bodyKey, headerKey);
  if (!key) validationFailed({ idempotencyKey: "An idempotency key is required for row writes." });
  return key;
}

/** Like `resolveBaseIdempotencyKey`, for operations where the key is optional (creates, agent rerun): null when neither is sent. */
export function resolveOptionalBaseIdempotencyKey(bodyKey: unknown, headerKey: string | null | undefined): string | null {
  const header = typeof headerKey === "string" && headerKey.trim() ? headerKey.trim() : null;
  const body = typeof bodyKey === "string" && bodyKey.trim() ? bodyKey.trim() : null;
  if (header && body && header !== body) {
    validationFailed({ idempotencyKey: "The Idempotency-Key header and body idempotencyKey differ." });
  }
  const key = body ?? header;
  if (key && !BASE_IDEMPOTENCY_KEY_PATTERN.test(key)) {
    validationFailed({ idempotencyKey: "Idempotency keys are 8-128 characters of letters, digits, '.', '_', ':', '-'." });
  }
  return key;
}

/** Request hash of a create: the parsed body without its key, scoped by operation and parent (`project:<id>` for a base). */
export function baseCreateRequestHash(operation: string, parentId: string, input: Record<string, unknown>): string {
  const { idempotencyKey: _key, ...rest } = input;
  return baseIdempotencyRequestHash({
    operation,
    baseId: parentId,
    viewId: null,
    rowId: null,
    values: rest,
    body: null,
    expectedVersion: null,
    lastWriteWins: false,
  });
}

export type BaseOperationReservation<T = BaseOperationResult> =
  | { id: string; replay: null }
  | { id: string; replay: T };

function parseCreated(value: unknown): BaseCreatedResult | null {
  if (!value || typeof value !== "object") return null;
  const createdId = (value as Record<string, unknown>).createdId;
  return typeof createdId === "string" ? { createdId } : null;
}

function parseResult(value: unknown): BaseOperationResult | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.rowIds) || !Array.isArray(record.versions)) return null;
  const rowIds = record.rowIds.filter((id): id is string => typeof id === "string");
  const versions = record.versions.filter((version): version is number => typeof version === "number");
  if (rowIds.length !== record.rowIds.length || versions.length !== record.versions.length) return null;
  return { rowIds, versions };
}

/**
 * Reserves the key inside the write transaction. A live record with the same
 * hash is a replay; a different hash is `409 idempotency_conflict`; an
 * expired record is replaced.
 */
export async function reserveBaseOperation(tx: BasesTx, input: BaseOperationReserveInput): Promise<BaseOperationReservation> {
  return reserveOperation(tx, input, parseResult);
}

/** `reserveBaseOperation` for a create inside an existing base (property, view, chart); the replay is `{ createdId }`. */
export async function reserveBaseCreateOperation(tx: BasesTx, input: BaseOperationReserveInput): Promise<BaseOperationReservation<BaseCreatedResult>> {
  return reserveOperation(tx, input, parseCreated);
}

export type BaseOperationReserveInput = {
  caller: BasesCaller;
  base: { id: string; organizationId: string; projectId: string };
  operation: string;
  key: string;
  requestHash: string;
  now?: Date;
};

/**
 * Base create, before the base exists (the record needs its base id): a live
 * record for the key replays (`{ createdId }`) or conflicts; an expired one
 * is deleted. The record itself is inserted with `insertBaseCreatedOperation`
 * after the base, in the same transaction.
 */
export async function checkBaseCreateOperation(
  tx: BasesTx,
  input: { caller: BasesCaller; organizationId: string; operation: string; key: string; requestHash: string; now?: Date },
): Promise<BaseCreatedResult | null> {
  const now = input.now ?? new Date();
  const scope = and(
    eq(schema.baseOperations.organizationId, input.organizationId),
    eq(schema.baseOperations.sourceKind, input.caller.source.kind),
    eq(schema.baseOperations.sourceId, input.caller.source.id),
    eq(schema.baseOperations.operation, input.operation),
    eq(schema.baseOperations.idempotencyKey, input.key),
  );
  const [existing] = await tx.select().from(schema.baseOperations).where(scope).limit(1).for("update");
  if (!existing) return null;
  if (existing.expiresAt.getTime() <= now.getTime()) {
    await tx.delete(schema.baseOperations).where(eq(schema.baseOperations.id, existing.id));
    return null;
  }
  if (existing.requestHash !== input.requestHash) {
    conflict("idempotency_conflict", { reason: "This idempotency key was used with a different request." });
  }
  const result = parseCreated(existing.resultJson);
  if (!result) conflict("idempotency_conflict", { reason: "The idempotency key is being used by another request." });
  return result;
}

/** Records a completed base create (see `checkBaseCreateOperation`). A concurrent twin raises a unique violation. */
export async function insertBaseCreatedOperation(
  tx: BasesTx,
  input: { caller: BasesCaller; base: { id: string; organizationId: string; projectId: string }; operation: string; key: string; requestHash: string; now?: Date },
) {
  const now = input.now ?? new Date();
  await tx.insert(schema.baseOperations).values({
    organizationId: input.base.organizationId,
    projectId: input.base.projectId,
    baseId: input.base.id,
    sourceKind: input.caller.source.kind,
    sourceId: input.caller.source.id,
    operation: input.operation,
    idempotencyKey: input.key,
    requestHash: input.requestHash,
    resultJson: { createdId: input.base.id },
    expiresAt: new Date(now.getTime() + BASES_LIMITS.idempotencyTtlMs),
  });
}

async function reserveOperation<T>(
  tx: BasesTx,
  input: BaseOperationReserveInput,
  parse: (value: unknown) => T | null,
): Promise<BaseOperationReservation<T>> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + BASES_LIMITS.idempotencyTtlMs);
  const scope = and(
    eq(schema.baseOperations.organizationId, input.base.organizationId),
    eq(schema.baseOperations.sourceKind, input.caller.source.kind),
    eq(schema.baseOperations.sourceId, input.caller.source.id),
    eq(schema.baseOperations.operation, input.operation),
    eq(schema.baseOperations.idempotencyKey, input.key),
  );
  const [inserted] = await tx
    .insert(schema.baseOperations)
    .values({
      organizationId: input.base.organizationId,
      projectId: input.base.projectId,
      baseId: input.base.id,
      sourceKind: input.caller.source.kind,
      sourceId: input.caller.source.id,
      operation: input.operation,
      idempotencyKey: input.key,
      requestHash: input.requestHash,
      resultJson: {},
      expiresAt,
    })
    .onConflictDoNothing()
    .returning({ id: schema.baseOperations.id });
  if (inserted) return { id: inserted.id, replay: null };

  const [existing] = await tx.select().from(schema.baseOperations).where(scope).limit(1).for("update");
  if (!existing) conflict("idempotency_conflict", { reason: "The idempotency key is being used by another request." });

  if (existing.expiresAt.getTime() <= now.getTime()) {
    await tx
      .update(schema.baseOperations)
      .set({
        projectId: input.base.projectId,
        baseId: input.base.id,
        requestHash: input.requestHash,
        resultJson: {},
        expiresAt,
        createdAt: now,
      })
      .where(eq(schema.baseOperations.id, existing.id));
    return { id: existing.id, replay: null };
  }
  if (existing.requestHash !== input.requestHash) {
    conflict("idempotency_conflict", { reason: "This idempotency key was used with a different request." });
  }
  const result = parse(existing.resultJson);
  if (!result) conflict("idempotency_conflict", { reason: "The idempotency key is being used by another request." });
  return { id: existing.id, replay: result };
}

export async function completeBaseOperation(tx: BasesTx, id: string, result: BaseOperationResult | BaseCreatedResult) {
  await tx.update(schema.baseOperations).set({ resultJson: result }).where(eq(schema.baseOperations.id, id));
}

/** Deletes idempotency records past `expires_at` (the periodic cleanup). Returns how many were removed. */
export async function deleteExpiredBaseOperations(executor: BasesExecutor, now: Date = new Date()): Promise<number> {
  const deleted = await executor
    .delete(schema.baseOperations)
    .where(lt(schema.baseOperations.expiresAt, now))
    .returning({ id: schema.baseOperations.id });
  return deleted.length;
}
