import { createHash, randomUUID } from "node:crypto";
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { executeWrite } from "../db/write-retry.js";
import { DELIVERY_BARRIER_VALUES, type DeliveryBarrier } from "../delivery-barriers.js";
import { getDb } from "../router/router-db.js";
import type { TurnOrigin } from "./turn-provenance.js";

const TURN_ORIGIN_VALUES = [
  "human",
  "cron",
  "trigger",
  "session-followup",
  "heartbeat",
  "observer",
  "task",
  "routine",
  "daemon-restart",
  "automation",
  "agent",
  "system",
  "background",
  "unknown",
] as const satisfies readonly TurnOrigin[];

export const RUNTIME_BOOT_EPOCH_STATUSES = ["active", "graceful_stopped", "abandoned"] as const;
export type RuntimeBootEpochStatus = (typeof RUNTIME_BOOT_EPOCH_STATUSES)[number];

export const RUNTIME_TURN_ATTEMPT_STATUSES = [
  "running",
  "complete",
  "failed",
  "interrupted",
  "timeout",
  "aborted",
] as const;
export type RuntimeTurnAttemptStatus = (typeof RUNTIME_TURN_ATTEMPT_STATUSES)[number];
export type RuntimeTurnAttemptTerminalStatus = Exclude<RuntimeTurnAttemptStatus, "running">;

export const RUNTIME_PROMPT_QUEUE_STATUSES = [
  "queued",
  "leased",
  "starting",
  "delivered",
  "complete",
  "cancelled",
  "superseded",
  "failed",
  "requeued",
  "deferred",
] as const;
export type RuntimePromptQueueStatus = (typeof RUNTIME_PROMPT_QUEUE_STATUSES)[number];

export const RUNTIME_RECOVERY_RUN_MODES = ["inspect", "dry-run", "apply"] as const;
export type RuntimeRecoveryRunMode = (typeof RUNTIME_RECOVERY_RUN_MODES)[number];
export type RuntimeRecoveryRunStatus = "running" | "complete" | "failed";

export const RUNTIME_RECOVERY_CANDIDATE_TYPES = ["turn_attempt", "prompt_queue", "legacy_session_turn"] as const;
export type RuntimeRecoveryCandidateType = (typeof RUNTIME_RECOVERY_CANDIDATE_TYPES)[number];

export const RUNTIME_RECOVERY_DECISIONS = [
  "resume",
  "requeue",
  "reconcile_interrupted",
  "defer_next_schedule",
  "ignore_stale",
  "manual_review",
] as const;
export type RuntimeRecoveryDecision = (typeof RUNTIME_RECOVERY_DECISIONS)[number];
export type RuntimeRecoveryActionStatus = "pending" | "not_applied" | "claimed" | "applied" | "failed";
export type RuntimeRecoveryClaimStatus = "claimed" | "applied" | "failed";

export const RUNTIME_TURN_ATTEMPT_INPUT_MUTATED_METADATA_KEY = "inputMutated";

type JsonRecord = Record<string, unknown>;

export interface RuntimeBootEpochRecord {
  bootEpoch: string;
  instanceId: string;
  pid: number;
  status: RuntimeBootEpochStatus;
  startedAt: number;
  lastHeartbeatAt: number;
  leaseExpiresAt: number;
  gracefulStoppedAt: number | null;
  abandonedAt: number | null;
  stopReason: string | null;
  metadata: JsonRecord | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateRuntimeBootEpochInput {
  bootEpoch?: string;
  instanceId: string;
  pid: number;
  startedAt?: number;
  lastHeartbeatAt?: number;
  leaseExpiresAt: number;
  metadata?: JsonRecord | null;
}

export interface RuntimeTurnAttemptRecord {
  attemptId: string;
  turnId: string;
  recoveredFromAttemptId: string | null;
  runId: string;
  sessionKey: string;
  sessionName: string | null;
  agentId: string;
  provider: string;
  model: string;
  bootEpoch: string;
  status: RuntimeTurnAttemptStatus;
  startedAt: number;
  leaseExpiresAt: number;
  lastHeartbeatAt: number;
  completedAt: number | null;
  requestBlobSha256: string | null;
  userPromptSha256: string | null;
  systemPromptSha256: string | null;
  checkpoint: unknown | null;
  originKind: TurnOrigin;
  source: unknown | null;
  turnProvenance: unknown | null;
  taskBarrierTaskId: string | null;
  deliveryBarrier: DeliveryBarrier;
  pendingIds: string[];
  startedTool: boolean;
  materializedOutput: boolean;
  recoveryClaimId: string | null;
  recoveryStatus: string | null;
  recoveryReason: string | null;
  recoveryRunId: string | null;
  recoveredAt: number | null;
  metadata: JsonRecord | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateRuntimeTurnAttemptInput {
  attemptId?: string;
  turnId: string;
  recoveredFromAttemptId?: string | null;
  runId: string;
  sessionKey: string;
  sessionName?: string | null;
  agentId: string;
  provider: string;
  model: string;
  bootEpoch: string;
  startedAt?: number;
  lastHeartbeatAt?: number;
  leaseExpiresAt: number;
  requestBlobSha256?: string | null;
  userPromptSha256?: string | null;
  systemPromptSha256?: string | null;
  checkpoint?: unknown;
  originKind: TurnOrigin;
  source?: unknown;
  turnProvenance?: unknown;
  taskBarrierTaskId?: string | null;
  deliveryBarrier: DeliveryBarrier;
  pendingIds?: string[];
  metadata?: JsonRecord | null;
}

export interface RuntimePromptQueueRecord {
  queueSequence: number;
  queueItemId: string;
  dedupeKey: string;
  immutableFingerprint: string;
  sessionKey: string;
  sessionName: string | null;
  agentId: string | null;
  laneKey: DeliveryBarrier;
  bootEpoch: string | null;
  status: RuntimePromptQueueStatus;
  originKind: TurnOrigin;
  deliveryBarrier: DeliveryBarrier;
  taskBarrierTaskId: string | null;
  pendingId: string | null;
  prompt: unknown;
  runtimeMessage: unknown;
  queuedAt: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  deliveredAttemptId: string | null;
  deliveredTurnId: string | null;
  completedAt: number | null;
  recoveryClaimId: string | null;
  recoveryStatus: string | null;
  recoveryReason: string | null;
  recoveryRunId: string | null;
  recoveredAt: number | null;
  metadata: JsonRecord | null;
  createdAt: number;
  updatedAt: number;
}

export interface EnqueueRuntimePromptInput {
  queueItemId?: string;
  dedupeKey: string;
  sessionKey: string;
  sessionName?: string | null;
  agentId?: string | null;
  laneKey: DeliveryBarrier;
  bootEpoch?: string | null;
  originKind: TurnOrigin;
  deliveryBarrier: DeliveryBarrier;
  taskBarrierTaskId?: string | null;
  pendingId?: string | null;
  prompt: unknown;
  runtimeMessage: unknown;
  queuedAt?: number;
  metadata?: JsonRecord | null;
}

export interface RuntimeRecoveryRunRecord {
  recoveryRunId: string;
  mode: RuntimeRecoveryRunMode;
  bootEpoch: string | null;
  status: RuntimeRecoveryRunStatus;
  startedAt: number;
  completedAt: number | null;
  summary: JsonRecord | null;
  error: string | null;
  metadata: JsonRecord | null;
  createdAt: number;
  updatedAt: number;
}

export interface RuntimeRecoveryCandidateRecord {
  recoveryRunId: string;
  candidateKey: string;
  candidateType: RuntimeRecoveryCandidateType;
  sessionKey: string;
  sessionName: string | null;
  attemptId: string | null;
  turnId: string | null;
  queueItemId: string | null;
  decision: RuntimeRecoveryDecision;
  reasonCode: string;
  action: string;
  actionStatus: RuntimeRecoveryActionStatus;
  claimId: string | null;
  details: JsonRecord | null;
  result: JsonRecord | null;
  actionCompletedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface RecordRuntimeRecoveryCandidateInput {
  recoveryRunId: string;
  candidateKey?: string;
  candidateType: RuntimeRecoveryCandidateType;
  sessionKey: string;
  sessionName?: string | null;
  attemptId?: string | null;
  turnId?: string | null;
  queueItemId?: string | null;
  decision: RuntimeRecoveryDecision;
  reasonCode: string;
  action: string;
  details?: JsonRecord | null;
  recordedAt?: number;
}

export interface RuntimeRecoveryClaimRecord {
  candidateKey: string;
  claimId: string;
  candidateType: Exclude<RuntimeRecoveryCandidateType, "legacy_session_turn">;
  sessionKey: string;
  attemptId: string | null;
  queueItemId: string | null;
  recoveryRunId: string;
  claimedByBootEpoch: string;
  status: RuntimeRecoveryClaimStatus;
  claimedAt: number;
  completedAt: number | null;
  result: JsonRecord | null;
  createdAt: number;
  updatedAt: number;
}

export class CrashRecoveryLedgerConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrashRecoveryLedgerConflictError";
  }
}

export class CrashRecoveryLedgerCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrashRecoveryLedgerCorruptionError";
  }
}

export class CrashRecoveryLedgerNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrashRecoveryLedgerNotFoundError";
  }
}

interface RuntimeBootEpochRow {
  boot_epoch: string;
  instance_id: string;
  pid: number;
  status: RuntimeBootEpochStatus;
  started_at: number;
  last_heartbeat_at: number;
  lease_expires_at: number;
  graceful_stopped_at: number | null;
  abandoned_at: number | null;
  stop_reason: string | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

interface RuntimeTurnAttemptRow {
  attempt_id: string;
  turn_id: string;
  recovered_from_attempt_id: string | null;
  run_id: string;
  session_key: string;
  session_name: string | null;
  agent_id: string;
  provider: string;
  model: string;
  boot_epoch: string;
  status: RuntimeTurnAttemptStatus;
  started_at: number;
  lease_expires_at: number;
  last_heartbeat_at: number;
  completed_at: number | null;
  request_blob_sha256: string | null;
  user_prompt_sha256: string | null;
  system_prompt_sha256: string | null;
  checkpoint_json: string | null;
  origin_kind: string;
  source_json: string | null;
  turn_provenance_json: string | null;
  task_barrier_task_id: string | null;
  delivery_barrier: string;
  pending_ids_json: string | null;
  started_tool: number;
  materialized_output: number;
  recovery_claim_id: string | null;
  recovery_status: string | null;
  recovery_reason: string | null;
  recovery_run_id: string | null;
  recovered_at: number | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

interface RuntimePromptQueueRow {
  queue_sequence: number;
  queue_item_id: string;
  dedupe_key: string;
  immutable_fingerprint: string;
  session_key: string;
  session_name: string | null;
  agent_id: string | null;
  lane_key: string;
  boot_epoch: string | null;
  status: RuntimePromptQueueStatus;
  origin_kind: string;
  delivery_barrier: string;
  task_barrier_task_id: string | null;
  pending_id: string | null;
  prompt_json: string;
  runtime_message_json: string;
  queued_at: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  delivered_attempt_id: string | null;
  delivered_turn_id: string | null;
  completed_at: number | null;
  recovery_claim_id: string | null;
  recovery_status: string | null;
  recovery_reason: string | null;
  recovery_run_id: string | null;
  recovered_at: number | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

interface RuntimeRecoveryRunRow {
  recovery_run_id: string;
  mode: RuntimeRecoveryRunMode;
  boot_epoch: string | null;
  status: RuntimeRecoveryRunStatus;
  started_at: number;
  completed_at: number | null;
  summary_json: string | null;
  error: string | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

interface RuntimeRecoveryCandidateRow {
  recovery_run_id: string;
  candidate_key: string;
  candidate_type: RuntimeRecoveryCandidateType;
  session_key: string;
  session_name: string | null;
  attempt_id: string | null;
  turn_id: string | null;
  queue_item_id: string | null;
  decision: RuntimeRecoveryDecision;
  reason_code: string;
  action: string;
  action_status: RuntimeRecoveryActionStatus;
  claim_id: string | null;
  details_json: string | null;
  result_json: string | null;
  action_completed_at: number | null;
  created_at: number;
  updated_at: number;
}

interface RuntimeRecoveryClaimRow {
  candidate_key: string;
  claim_id: string;
  candidate_type: Exclude<RuntimeRecoveryCandidateType, "legacy_session_turn">;
  session_key: string;
  attempt_id: string | null;
  queue_item_id: string | null;
  recovery_run_id: string;
  claimed_by_boot_epoch: string;
  status: RuntimeRecoveryClaimStatus;
  claimed_at: number;
  completed_at: number | null;
  result_json: string | null;
  created_at: number;
  updated_at: number;
}

const TERMINAL_QUEUE_STATUSES = new Set<RuntimePromptQueueStatus>(["complete", "cancelled", "superseded", "failed"]);
const RUNTIME_BOOT_EPOCH_STATUS_SET = new Set<string>(RUNTIME_BOOT_EPOCH_STATUSES);
const RUNTIME_TURN_ATTEMPT_STATUS_SET = new Set<string>(RUNTIME_TURN_ATTEMPT_STATUSES);
const RUNTIME_PROMPT_QUEUE_STATUS_SET = new Set<string>(RUNTIME_PROMPT_QUEUE_STATUSES);
const RUNTIME_RECOVERY_RUN_MODE_SET = new Set<string>(RUNTIME_RECOVERY_RUN_MODES);
const RUNTIME_RECOVERY_RUN_STATUS_SET = new Set<string>(["running", "complete", "failed"]);
const RUNTIME_RECOVERY_CANDIDATE_TYPE_SET = new Set<string>(RUNTIME_RECOVERY_CANDIDATE_TYPES);
const RUNTIME_RECOVERY_CLAIM_CANDIDATE_TYPE_SET = new Set<string>(["turn_attempt", "prompt_queue"]);
const RUNTIME_RECOVERY_DECISION_SET = new Set<string>(RUNTIME_RECOVERY_DECISIONS);
const RUNTIME_RECOVERY_ACTION_STATUS_SET = new Set<string>(["pending", "not_applied", "claimed", "applied", "failed"]);
const RUNTIME_RECOVERY_CLAIM_STATUS_SET = new Set<string>(["claimed", "applied", "failed"]);
const ALLOWED_QUEUE_STATUS_TRANSITIONS: Readonly<
  Record<RuntimePromptQueueStatus, ReadonlySet<RuntimePromptQueueStatus>>
> = {
  queued: new Set(["queued", "leased", "deferred", "cancelled", "superseded", "failed"]),
  leased: new Set(["leased", "starting", "requeued", "deferred", "cancelled", "superseded", "failed"]),
  starting: new Set(["starting", "delivered", "requeued", "deferred", "cancelled", "superseded", "failed"]),
  delivered: new Set(["delivered", "complete", "failed"]),
  complete: new Set(["complete"]),
  cancelled: new Set(["cancelled"]),
  superseded: new Set(["superseded"]),
  failed: new Set(["failed"]),
  requeued: new Set(["requeued", "leased", "deferred", "cancelled", "superseded", "failed"]),
  deferred: new Set(["deferred", "queued", "requeued", "leased", "cancelled", "superseded", "failed"]),
};
const TURN_ORIGIN_SET = new Set<string>(TURN_ORIGIN_VALUES);
const DELIVERY_BARRIER_SET = new Set<string>(DELIVERY_BARRIER_VALUES);

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function optionalText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function assertTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative Unix millisecond timestamp`);
  }
  return value;
}

function assertPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function assertLimit(value: number | undefined): number {
  const limit = value ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("limit must be an integer between 1 and 1000");
  }
  return limit;
}

function requireTurnOrigin(value: unknown, label: string): TurnOrigin {
  if (typeof value !== "string" || !TURN_ORIGIN_SET.has(value)) {
    throw new Error(`${label} must be a canonical runtime turn origin`);
  }
  return value as TurnOrigin;
}

function requireDeliveryBarrier(value: unknown, label: string): DeliveryBarrier {
  if (typeof value !== "string" || !DELIVERY_BARRIER_SET.has(value)) {
    throw new Error(`${label} must be a canonical delivery barrier`);
  }
  return value as DeliveryBarrier;
}

function parsePersistedTurnOrigin(value: unknown, label: string): TurnOrigin {
  try {
    return requireTurnOrigin(value, label);
  } catch {
    throw new CrashRecoveryLedgerCorruptionError(`Invalid ${label} in crash recovery ledger`);
  }
}

function parsePersistedDeliveryBarrier(value: unknown, label: string): DeliveryBarrier {
  try {
    return requireDeliveryBarrier(value, label);
  } catch {
    throw new CrashRecoveryLedgerCorruptionError(`Invalid ${label} in crash recovery ledger`);
  }
}

function parsePersistedEnum<T extends string>(value: unknown, allowed: ReadonlySet<string>, label: string): T {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new CrashRecoveryLedgerCorruptionError(`Invalid ${label} in crash recovery ledger`);
  }
  return value as T;
}

function parsePersistedBoolean(value: unknown, label: string): boolean {
  if (value !== 0 && value !== 1) {
    throw new CrashRecoveryLedgerCorruptionError(`Invalid ${label} in crash recovery ledger`);
  }
  return value === 1;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    const sorted: JsonRecord = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortJson((value as JsonRecord)[key]);
    }
    return sorted;
  }
  return value;
}

function stringifyRequiredJson(value: unknown, label: string): string {
  if (value === null || value === undefined) throw new Error(`${label} is required`);
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error(`${label} must be JSON serializable`);
  return JSON.stringify(sortJson(JSON.parse(serialized) as unknown));
}

function stringifyOptionalJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return stringifyRequiredJson(value, "JSON value");
}

function parseRequiredJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new CrashRecoveryLedgerCorruptionError(`Invalid ${label} JSON in crash recovery ledger`);
  }
}

function parseOptionalJson(value: string | null, label: string): unknown | null {
  return value === null ? null : parseRequiredJson(value, label);
}

function parseOptionalRecord(value: string | null, label: string): JsonRecord | null {
  const parsed = parseOptionalJson(value, label);
  if (parsed === null) return null;
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CrashRecoveryLedgerCorruptionError(`${label} must be a JSON object in crash recovery ledger`);
  }
  return parsed as JsonRecord;
}

function parseStringArray(value: string | null, label: string): string[] {
  if (value === null) return [];
  const parsed = parseRequiredJson(value, label);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new CrashRecoveryLedgerCorruptionError(`${label} must be a JSON string array in crash recovery ledger`);
  }
  return parsed as string[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function buildRuntimeRecoveryCandidateKey(input: {
  candidateType: RuntimeRecoveryCandidateType;
  sessionKey: string;
  attemptId?: string | null;
  turnId?: string | null;
  queueItemId?: string | null;
}): string {
  const sessionKey = requiredText(input.sessionKey, "sessionKey");
  if (input.candidateType === "turn_attempt") {
    return `attempt:${requiredText(input.attemptId ?? "", "attemptId")}`;
  }
  if (input.candidateType === "prompt_queue") {
    return `queue:${requiredText(input.queueItemId ?? "", "queueItemId")}`;
  }
  const turnId = requiredText(input.turnId ?? "", "turnId");
  return `legacy:${sha256(`${sessionKey}\u0000${turnId}`)}`;
}

function rowToBootEpoch(row: RuntimeBootEpochRow): RuntimeBootEpochRecord {
  return {
    bootEpoch: row.boot_epoch,
    instanceId: row.instance_id,
    pid: row.pid,
    status: parsePersistedEnum<RuntimeBootEpochStatus>(
      row.status,
      RUNTIME_BOOT_EPOCH_STATUS_SET,
      "runtime_boot_epochs.status",
    ),
    startedAt: row.started_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    leaseExpiresAt: row.lease_expires_at,
    gracefulStoppedAt: row.graceful_stopped_at,
    abandonedAt: row.abandoned_at,
    stopReason: row.stop_reason,
    metadata: parseOptionalRecord(row.metadata_json, "runtime_boot_epochs.metadata_json"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToTurnAttempt(row: RuntimeTurnAttemptRow): RuntimeTurnAttemptRecord {
  return {
    attemptId: row.attempt_id,
    turnId: row.turn_id,
    recoveredFromAttemptId: row.recovered_from_attempt_id,
    runId: row.run_id,
    sessionKey: row.session_key,
    sessionName: row.session_name,
    agentId: row.agent_id,
    provider: row.provider,
    model: row.model,
    bootEpoch: row.boot_epoch,
    status: parsePersistedEnum<RuntimeTurnAttemptStatus>(
      row.status,
      RUNTIME_TURN_ATTEMPT_STATUS_SET,
      "runtime_turn_attempts.status",
    ),
    startedAt: row.started_at,
    leaseExpiresAt: row.lease_expires_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    completedAt: row.completed_at,
    requestBlobSha256: row.request_blob_sha256,
    userPromptSha256: row.user_prompt_sha256,
    systemPromptSha256: row.system_prompt_sha256,
    checkpoint: parseOptionalJson(row.checkpoint_json, "runtime_turn_attempts.checkpoint_json"),
    originKind: parsePersistedTurnOrigin(row.origin_kind, "runtime_turn_attempts.origin_kind"),
    source: parseOptionalJson(row.source_json, "runtime_turn_attempts.source_json"),
    turnProvenance: parseOptionalJson(row.turn_provenance_json, "runtime_turn_attempts.turn_provenance_json"),
    taskBarrierTaskId: row.task_barrier_task_id,
    deliveryBarrier: parsePersistedDeliveryBarrier(row.delivery_barrier, "runtime_turn_attempts.delivery_barrier"),
    pendingIds: parseStringArray(row.pending_ids_json, "runtime_turn_attempts.pending_ids_json"),
    startedTool: parsePersistedBoolean(row.started_tool, "runtime_turn_attempts.started_tool"),
    materializedOutput: parsePersistedBoolean(row.materialized_output, "runtime_turn_attempts.materialized_output"),
    recoveryClaimId: row.recovery_claim_id,
    recoveryStatus: row.recovery_status,
    recoveryReason: row.recovery_reason,
    recoveryRunId: row.recovery_run_id,
    recoveredAt: row.recovered_at,
    metadata: parseOptionalRecord(row.metadata_json, "runtime_turn_attempts.metadata_json"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToPromptQueue(row: RuntimePromptQueueRow): RuntimePromptQueueRecord {
  const laneKey = parsePersistedDeliveryBarrier(row.lane_key, "runtime_prompt_queue.lane_key");
  const status = parsePersistedEnum<RuntimePromptQueueStatus>(
    row.status,
    RUNTIME_PROMPT_QUEUE_STATUS_SET,
    "runtime_prompt_queue.status",
  );
  const originKind = parsePersistedTurnOrigin(row.origin_kind, "runtime_prompt_queue.origin_kind");
  const deliveryBarrier = parsePersistedDeliveryBarrier(row.delivery_barrier, "runtime_prompt_queue.delivery_barrier");
  const prompt = parseRequiredJson(row.prompt_json, "runtime_prompt_queue.prompt_json");
  const runtimeMessage = parseRequiredJson(row.runtime_message_json, "runtime_prompt_queue.runtime_message_json");
  const metadata = parseOptionalRecord(row.metadata_json, "runtime_prompt_queue.metadata_json");
  const ownerBound = status === "leased" || status === "starting" || status === "delivered";
  if (ownerBound && (row.boot_epoch === null || row.lease_owner === null || row.lease_expires_at === null)) {
    throw new CrashRecoveryLedgerCorruptionError(
      `Owner-bound runtime prompt queue item ${row.queue_item_id} has an incomplete lease`,
    );
  }
  if ((row.lease_owner === null) !== (row.lease_expires_at === null)) {
    throw new CrashRecoveryLedgerCorruptionError(
      `Runtime prompt queue item ${row.queue_item_id} has a partial lease fence`,
    );
  }
  if (status === "delivered" && (row.delivered_attempt_id === null || row.delivered_turn_id === null)) {
    throw new CrashRecoveryLedgerCorruptionError(
      `Delivered runtime prompt queue item ${row.queue_item_id} has no delivery identity`,
    );
  }
  if (TERMINAL_QUEUE_STATUSES.has(status) !== (row.completed_at !== null)) {
    throw new CrashRecoveryLedgerCorruptionError(
      `Runtime prompt queue item ${row.queue_item_id} has inconsistent terminal timestamps`,
    );
  }
  const persistedFingerprint = promptQueueFingerprint({
    dedupeKey: row.dedupe_key,
    sessionKey: row.session_key,
    sessionName: row.session_name,
    agentId: row.agent_id,
    laneKey,
    originKind,
    deliveryBarrier,
    taskBarrierTaskId: row.task_barrier_task_id,
    pendingId: row.pending_id,
    promptJson: row.prompt_json,
    runtimeMessageJson: row.runtime_message_json,
    metadataJson: row.metadata_json,
  });
  if (persistedFingerprint !== row.immutable_fingerprint) {
    throw new CrashRecoveryLedgerCorruptionError(
      `Immutable fingerprint mismatch for runtime prompt queue item ${row.queue_item_id}`,
    );
  }
  return {
    queueSequence: row.queue_sequence,
    queueItemId: row.queue_item_id,
    dedupeKey: row.dedupe_key,
    immutableFingerprint: row.immutable_fingerprint,
    sessionKey: row.session_key,
    sessionName: row.session_name,
    agentId: row.agent_id,
    laneKey,
    bootEpoch: row.boot_epoch,
    status,
    originKind,
    deliveryBarrier,
    taskBarrierTaskId: row.task_barrier_task_id,
    pendingId: row.pending_id,
    prompt,
    runtimeMessage,
    queuedAt: row.queued_at,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    deliveredAttemptId: row.delivered_attempt_id,
    deliveredTurnId: row.delivered_turn_id,
    completedAt: row.completed_at,
    recoveryClaimId: row.recovery_claim_id,
    recoveryStatus: row.recovery_status,
    recoveryReason: row.recovery_reason,
    recoveryRunId: row.recovery_run_id,
    recoveredAt: row.recovered_at,
    metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToRecoveryRun(row: RuntimeRecoveryRunRow): RuntimeRecoveryRunRecord {
  return {
    recoveryRunId: row.recovery_run_id,
    mode: parsePersistedEnum<RuntimeRecoveryRunMode>(
      row.mode,
      RUNTIME_RECOVERY_RUN_MODE_SET,
      "runtime_recovery_runs.mode",
    ),
    bootEpoch: row.boot_epoch,
    status: parsePersistedEnum<RuntimeRecoveryRunStatus>(
      row.status,
      RUNTIME_RECOVERY_RUN_STATUS_SET,
      "runtime_recovery_runs.status",
    ),
    startedAt: row.started_at,
    completedAt: row.completed_at,
    summary: parseOptionalRecord(row.summary_json, "runtime_recovery_runs.summary_json"),
    error: row.error,
    metadata: parseOptionalRecord(row.metadata_json, "runtime_recovery_runs.metadata_json"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToRecoveryCandidate(row: RuntimeRecoveryCandidateRow): RuntimeRecoveryCandidateRecord {
  return {
    recoveryRunId: row.recovery_run_id,
    candidateKey: row.candidate_key,
    candidateType: parsePersistedEnum<RuntimeRecoveryCandidateType>(
      row.candidate_type,
      RUNTIME_RECOVERY_CANDIDATE_TYPE_SET,
      "runtime_recovery_candidates.candidate_type",
    ),
    sessionKey: row.session_key,
    sessionName: row.session_name,
    attemptId: row.attempt_id,
    turnId: row.turn_id,
    queueItemId: row.queue_item_id,
    decision: parsePersistedEnum<RuntimeRecoveryDecision>(
      row.decision,
      RUNTIME_RECOVERY_DECISION_SET,
      "runtime_recovery_candidates.decision",
    ),
    reasonCode: row.reason_code,
    action: row.action,
    actionStatus: parsePersistedEnum<RuntimeRecoveryActionStatus>(
      row.action_status,
      RUNTIME_RECOVERY_ACTION_STATUS_SET,
      "runtime_recovery_candidates.action_status",
    ),
    claimId: row.claim_id,
    details: parseOptionalRecord(row.details_json, "runtime_recovery_candidates.details_json"),
    result: parseOptionalRecord(row.result_json, "runtime_recovery_candidates.result_json"),
    actionCompletedAt: row.action_completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToRecoveryClaim(row: RuntimeRecoveryClaimRow): RuntimeRecoveryClaimRecord {
  return {
    candidateKey: row.candidate_key,
    claimId: row.claim_id,
    candidateType: parsePersistedEnum<Exclude<RuntimeRecoveryCandidateType, "legacy_session_turn">>(
      row.candidate_type,
      RUNTIME_RECOVERY_CLAIM_CANDIDATE_TYPE_SET,
      "runtime_recovery_claims.candidate_type",
    ),
    sessionKey: row.session_key,
    attemptId: row.attempt_id,
    queueItemId: row.queue_item_id,
    recoveryRunId: row.recovery_run_id,
    claimedByBootEpoch: row.claimed_by_boot_epoch,
    status: parsePersistedEnum<RuntimeRecoveryClaimStatus>(
      row.status,
      RUNTIME_RECOVERY_CLAIM_STATUS_SET,
      "runtime_recovery_claims.status",
    ),
    claimedAt: row.claimed_at,
    completedAt: row.completed_at,
    result: parseOptionalRecord(row.result_json, "runtime_recovery_claims.result_json"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getBootEpochRow(database: Database, bootEpoch: string): RuntimeBootEpochRow | null {
  return (
    (database.prepare("SELECT * FROM runtime_boot_epochs WHERE boot_epoch = ?").get(bootEpoch) as
      | RuntimeBootEpochRow
      | undefined) ?? null
  );
}

function getTurnAttemptRow(database: Database, attemptId: string): RuntimeTurnAttemptRow | null {
  return (
    (database.prepare("SELECT * FROM runtime_turn_attempts WHERE attempt_id = ?").get(attemptId) as
      | RuntimeTurnAttemptRow
      | undefined) ?? null
  );
}

function getPromptQueueRow(database: Database, queueItemId: string): RuntimePromptQueueRow | null {
  return (
    (database.prepare("SELECT * FROM runtime_prompt_queue WHERE queue_item_id = ?").get(queueItemId) as
      | RuntimePromptQueueRow
      | undefined) ?? null
  );
}

function getRecoveryRunRow(database: Database, recoveryRunId: string): RuntimeRecoveryRunRow | null {
  return (
    (database.prepare("SELECT * FROM runtime_recovery_runs WHERE recovery_run_id = ?").get(recoveryRunId) as
      | RuntimeRecoveryRunRow
      | undefined) ?? null
  );
}

function getRecoveryCandidateRow(
  database: Database,
  recoveryRunId: string,
  candidateKey: string,
): RuntimeRecoveryCandidateRow | null {
  return (
    (database
      .prepare("SELECT * FROM runtime_recovery_candidates WHERE recovery_run_id = ? AND candidate_key = ?")
      .get(recoveryRunId, candidateKey) as RuntimeRecoveryCandidateRow | undefined) ?? null
  );
}

function getRecoveryClaimByCandidateRow(database: Database, candidateKey: string): RuntimeRecoveryClaimRow | null {
  return (
    (database.prepare("SELECT * FROM runtime_recovery_claims WHERE candidate_key = ?").get(candidateKey) as
      | RuntimeRecoveryClaimRow
      | undefined) ?? null
  );
}

export function createRuntimeBootEpoch(input: CreateRuntimeBootEpochInput): RuntimeBootEpochRecord {
  const bootEpoch = requiredText(input.bootEpoch ?? `boot_${randomUUID()}`, "bootEpoch");
  const instanceId = requiredText(input.instanceId, "instanceId");
  const pid = assertPositiveInteger(input.pid, "pid");
  const startedAt = assertTimestamp(input.startedAt ?? Date.now(), "startedAt");
  const lastHeartbeatAt = assertTimestamp(input.lastHeartbeatAt ?? startedAt, "lastHeartbeatAt");
  const leaseExpiresAt = assertTimestamp(input.leaseExpiresAt, "leaseExpiresAt");
  if (lastHeartbeatAt < startedAt) throw new Error("lastHeartbeatAt cannot precede startedAt");
  if (leaseExpiresAt <= lastHeartbeatAt) throw new Error("leaseExpiresAt must be after lastHeartbeatAt");
  const metadataJson = stringifyOptionalJson(input.metadata);

  return executeWrite(
    getDb(),
    (database) => {
      const existing = getBootEpochRow(database, bootEpoch);
      if (existing) {
        const matches =
          existing.instance_id === instanceId &&
          existing.pid === pid &&
          existing.started_at === startedAt &&
          existing.last_heartbeat_at === lastHeartbeatAt &&
          existing.lease_expires_at === leaseExpiresAt &&
          existing.metadata_json === metadataJson;
        if (!matches) {
          throw new CrashRecoveryLedgerConflictError(`Boot epoch ${bootEpoch} already exists with different identity`);
        }
        return rowToBootEpoch(existing);
      }

      database
        .prepare(
          `INSERT INTO runtime_boot_epochs (
             boot_epoch, instance_id, pid, status, started_at, last_heartbeat_at, lease_expires_at,
             metadata_json, created_at, updated_at
           ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          bootEpoch,
          instanceId,
          pid,
          startedAt,
          lastHeartbeatAt,
          leaseExpiresAt,
          metadataJson,
          startedAt,
          startedAt,
        );
      const row = getBootEpochRow(database, bootEpoch);
      if (!row) throw new CrashRecoveryLedgerNotFoundError(`Boot epoch ${bootEpoch} missing after insert`);
      return rowToBootEpoch(row);
    },
    { label: "runtime-crash-recovery-create-boot" },
  );
}

export function getRuntimeBootEpoch(bootEpoch: string): RuntimeBootEpochRecord | null {
  const row = getBootEpochRow(getDb(), requiredText(bootEpoch, "bootEpoch"));
  return row ? rowToBootEpoch(row) : null;
}

export function listRuntimeBootEpochs(
  options: { instanceId?: string; status?: RuntimeBootEpochStatus; limit?: number } = {},
): RuntimeBootEpochRecord[] {
  const where: string[] = [];
  const params: SQLQueryBindings[] = [];
  if (options.instanceId) {
    where.push("instance_id = ?");
    params.push(requiredText(options.instanceId, "instanceId"));
  }
  if (options.status) {
    where.push("status = ?");
    params.push(options.status);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(`SELECT * FROM runtime_boot_epochs ${whereSql} ORDER BY started_at DESC, boot_epoch DESC LIMIT ?`)
    .all(...params, assertLimit(options.limit)) as RuntimeBootEpochRow[];
  return rows.map(rowToBootEpoch);
}

export function heartbeatRuntimeBootEpoch(input: {
  bootEpoch: string;
  heartbeatAt?: number;
  leaseExpiresAt: number;
}): RuntimeBootEpochRecord {
  const bootEpoch = requiredText(input.bootEpoch, "bootEpoch");
  const heartbeatAt = assertTimestamp(input.heartbeatAt ?? Date.now(), "heartbeatAt");
  const leaseExpiresAt = assertTimestamp(input.leaseExpiresAt, "leaseExpiresAt");
  if (leaseExpiresAt <= heartbeatAt) throw new Error("leaseExpiresAt must be after heartbeatAt");

  return executeWrite(
    getDb(),
    (database) => {
      const current = getBootEpochRow(database, bootEpoch);
      if (!current) throw new CrashRecoveryLedgerNotFoundError(`Boot epoch not found: ${bootEpoch}`);
      if (current.status !== "active") {
        throw new CrashRecoveryLedgerConflictError(`Cannot heartbeat terminal boot epoch ${bootEpoch}`);
      }
      if (
        heartbeatAt < current.last_heartbeat_at ||
        heartbeatAt < current.updated_at ||
        leaseExpiresAt < current.lease_expires_at
      ) {
        throw new CrashRecoveryLedgerConflictError(`Cannot move boot epoch ${bootEpoch} heartbeat or lease backwards`);
      }
      if (heartbeatAt === current.last_heartbeat_at && leaseExpiresAt === current.lease_expires_at) {
        return rowToBootEpoch(current);
      }
      const result = database
        .prepare(
          `UPDATE runtime_boot_epochs
           SET last_heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
           WHERE boot_epoch = ? AND status = 'active'`,
        )
        .run(heartbeatAt, leaseExpiresAt, heartbeatAt, bootEpoch);
      if (result.changes !== 1) {
        throw new CrashRecoveryLedgerConflictError(`Boot epoch ${bootEpoch} lost its heartbeat transition race`);
      }
      const row = getBootEpochRow(database, bootEpoch);
      if (!row) throw new CrashRecoveryLedgerNotFoundError(`Boot epoch not found after heartbeat: ${bootEpoch}`);
      return rowToBootEpoch(row);
    },
    { label: "runtime-crash-recovery-heartbeat-boot" },
  );
}

function terminalizeRuntimeBootEpoch(input: {
  bootEpoch: string;
  status: Exclude<RuntimeBootEpochStatus, "active">;
  terminalAt?: number;
  reason?: string | null;
  expectedLastHeartbeatAt?: number;
  expectedLeaseExpiresAt?: number;
}): RuntimeBootEpochRecord {
  const bootEpoch = requiredText(input.bootEpoch, "bootEpoch");
  const terminalAt = assertTimestamp(input.terminalAt ?? Date.now(), "terminalAt");
  const reason = optionalText(input.reason);

  return executeWrite(
    getDb(),
    (database) => {
      const current = getBootEpochRow(database, bootEpoch);
      if (!current) throw new CrashRecoveryLedgerNotFoundError(`Boot epoch not found: ${bootEpoch}`);
      if (current.status === input.status) {
        const currentTerminalAt =
          input.status === "graceful_stopped" ? current.graceful_stopped_at : current.abandoned_at;
        if (input.terminalAt !== undefined && terminalAt !== currentTerminalAt) {
          throw new CrashRecoveryLedgerConflictError(`Boot epoch ${bootEpoch} already has a different terminal time`);
        }
        if (input.reason !== undefined && reason !== current.stop_reason) {
          throw new CrashRecoveryLedgerConflictError(`Boot epoch ${bootEpoch} already has a different stop reason`);
        }
        return rowToBootEpoch(current);
      }
      if (current.status !== "active") {
        throw new CrashRecoveryLedgerConflictError(
          `Cannot transition boot epoch ${bootEpoch} from ${current.status} to ${input.status}`,
        );
      }
      if (terminalAt < current.last_heartbeat_at || terminalAt < current.updated_at) {
        throw new CrashRecoveryLedgerConflictError("terminalAt cannot precede the latest boot observation");
      }
      if (input.status === "abandoned") {
        if (input.expectedLastHeartbeatAt === undefined || input.expectedLeaseExpiresAt === undefined) {
          throw new Error("Abandoning a boot requires the observed heartbeat and lease fence");
        }
        const expectedHeartbeat = assertTimestamp(input.expectedLastHeartbeatAt, "expectedLastHeartbeatAt");
        const expectedLease = assertTimestamp(input.expectedLeaseExpiresAt, "expectedLeaseExpiresAt");
        if (current.last_heartbeat_at !== expectedHeartbeat || current.lease_expires_at !== expectedLease) {
          throw new CrashRecoveryLedgerConflictError(`Boot epoch ${bootEpoch} changed after it was observed`);
        }
        if (terminalAt < expectedLease) {
          throw new CrashRecoveryLedgerConflictError(`Boot epoch ${bootEpoch} cannot be abandoned before lease expiry`);
        }
      }
      const gracefulStoppedAt = input.status === "graceful_stopped" ? terminalAt : null;
      const abandonedAt = input.status === "abandoned" ? terminalAt : null;
      const result = database
        .prepare(
          `UPDATE runtime_boot_epochs
           SET status = ?, graceful_stopped_at = ?, abandoned_at = ?, stop_reason = ?, updated_at = ?
           WHERE boot_epoch = ? AND status = 'active'
             AND last_heartbeat_at = ? AND lease_expires_at = ?`,
        )
        .run(
          input.status,
          gracefulStoppedAt,
          abandonedAt,
          reason,
          terminalAt,
          bootEpoch,
          current.last_heartbeat_at,
          current.lease_expires_at,
        );
      if (result.changes !== 1) {
        throw new CrashRecoveryLedgerConflictError(`Boot epoch ${bootEpoch} lost its terminal transition race`);
      }
      const row = getBootEpochRow(database, bootEpoch);
      if (!row)
        throw new CrashRecoveryLedgerNotFoundError(`Boot epoch not found after terminal transition: ${bootEpoch}`);
      return rowToBootEpoch(row);
    },
    { label: `runtime-crash-recovery-${input.status}-boot` },
  );
}

export function markRuntimeBootEpochGracefulStopped(input: {
  bootEpoch: string;
  stoppedAt?: number;
  reason?: string | null;
}): RuntimeBootEpochRecord {
  return terminalizeRuntimeBootEpoch({
    bootEpoch: input.bootEpoch,
    status: "graceful_stopped",
    terminalAt: input.stoppedAt,
    reason: input.reason,
  });
}

export function markRuntimeBootEpochAbandoned(input: {
  bootEpoch: string;
  abandonedAt?: number;
  reason?: string | null;
  expectedLastHeartbeatAt: number;
  expectedLeaseExpiresAt: number;
}): RuntimeBootEpochRecord {
  return terminalizeRuntimeBootEpoch({
    bootEpoch: input.bootEpoch,
    status: "abandoned",
    terminalAt: input.abandonedAt,
    reason: input.reason,
    expectedLastHeartbeatAt: input.expectedLastHeartbeatAt,
    expectedLeaseExpiresAt: input.expectedLeaseExpiresAt,
  });
}

export function createRuntimeTurnAttempt(input: CreateRuntimeTurnAttemptInput): RuntimeTurnAttemptRecord {
  const attemptId = requiredText(input.attemptId ?? `attempt_${randomUUID()}`, "attemptId");
  const turnId = requiredText(input.turnId, "turnId");
  const recoveredFromAttemptId = optionalText(input.recoveredFromAttemptId);
  const runId = requiredText(input.runId, "runId");
  const sessionKey = requiredText(input.sessionKey, "sessionKey");
  const sessionName = optionalText(input.sessionName);
  const agentId = requiredText(input.agentId, "agentId");
  const provider = requiredText(input.provider, "provider");
  const model = requiredText(input.model, "model");
  const bootEpoch = requiredText(input.bootEpoch, "bootEpoch");
  const startedAt = assertTimestamp(input.startedAt ?? Date.now(), "startedAt");
  const lastHeartbeatAt = assertTimestamp(input.lastHeartbeatAt ?? startedAt, "lastHeartbeatAt");
  const leaseExpiresAt = assertTimestamp(input.leaseExpiresAt, "leaseExpiresAt");
  if (lastHeartbeatAt < startedAt) throw new Error("lastHeartbeatAt cannot precede startedAt");
  if (leaseExpiresAt <= lastHeartbeatAt) throw new Error("leaseExpiresAt must be after lastHeartbeatAt");
  const requestBlobSha256 = optionalText(input.requestBlobSha256);
  const userPromptSha256 = optionalText(input.userPromptSha256);
  const systemPromptSha256 = optionalText(input.systemPromptSha256);
  const checkpointJson = stringifyOptionalJson(input.checkpoint);
  if (!requestBlobSha256 && !checkpointJson) {
    throw new Error("Turn attempt requires a durable request blob hash or provider checkpoint");
  }
  const originKind = requireTurnOrigin(input.originKind, "originKind");
  const sourceJson = stringifyOptionalJson(input.source);
  const provenanceJson = stringifyOptionalJson(input.turnProvenance);
  const taskBarrierTaskId = optionalText(input.taskBarrierTaskId);
  const deliveryBarrier = requireDeliveryBarrier(input.deliveryBarrier, "deliveryBarrier");
  const pendingIdsJson = input.pendingIds?.length ? stringifyRequiredJson(input.pendingIds, "pendingIds") : null;
  const metadataJson = stringifyOptionalJson(input.metadata);

  return executeWrite(
    getDb(),
    (database) => {
      const existing = getTurnAttemptRow(database, attemptId);
      if (existing) {
        const matches =
          existing.turn_id === turnId &&
          existing.recovered_from_attempt_id === recoveredFromAttemptId &&
          existing.run_id === runId &&
          existing.session_key === sessionKey &&
          existing.session_name === sessionName &&
          existing.agent_id === agentId &&
          existing.provider === provider &&
          existing.model === model &&
          existing.boot_epoch === bootEpoch &&
          existing.started_at === startedAt &&
          existing.lease_expires_at === leaseExpiresAt &&
          existing.last_heartbeat_at === lastHeartbeatAt &&
          existing.request_blob_sha256 === requestBlobSha256 &&
          existing.user_prompt_sha256 === userPromptSha256 &&
          existing.system_prompt_sha256 === systemPromptSha256 &&
          existing.checkpoint_json === checkpointJson &&
          existing.origin_kind === originKind &&
          existing.source_json === sourceJson &&
          existing.turn_provenance_json === provenanceJson &&
          existing.task_barrier_task_id === taskBarrierTaskId &&
          existing.delivery_barrier === deliveryBarrier &&
          existing.pending_ids_json === pendingIdsJson &&
          existing.metadata_json === metadataJson;
        if (!matches) {
          throw new CrashRecoveryLedgerConflictError(
            `Attempt ${attemptId} already exists with different immutable data`,
          );
        }
        return rowToTurnAttempt(existing);
      }
      const boot = getBootEpochRow(database, bootEpoch);
      if (!boot) throw new CrashRecoveryLedgerNotFoundError(`Owning boot epoch not found: ${bootEpoch}`);
      if (boot.status !== "active") {
        throw new CrashRecoveryLedgerConflictError(`Cannot create attempt for terminal boot epoch ${bootEpoch}`);
      }
      if (startedAt < boot.started_at || boot.lease_expires_at <= startedAt) {
        throw new CrashRecoveryLedgerConflictError(
          `Cannot create attempt outside the live lease for boot ${bootEpoch}`,
        );
      }
      if (leaseExpiresAt > boot.lease_expires_at) {
        throw new CrashRecoveryLedgerConflictError("Attempt lease cannot outlive its owning boot lease");
      }
      if (recoveredFromAttemptId) {
        const previous = getTurnAttemptRow(database, recoveredFromAttemptId);
        if (!previous) {
          throw new CrashRecoveryLedgerNotFoundError(`Recovered-from attempt not found: ${recoveredFromAttemptId}`);
        }
        if (previous.status === "running") {
          throw new CrashRecoveryLedgerConflictError(
            `Recovered-from attempt ${recoveredFromAttemptId} is still running`,
          );
        }
        if (previous.turn_id !== turnId) {
          throw new CrashRecoveryLedgerConflictError("Recovered attempt must retain the same logical turnId");
        }
      }
      database
        .prepare(
          `INSERT INTO runtime_turn_attempts (
             attempt_id, turn_id, recovered_from_attempt_id, run_id, session_key, session_name, agent_id,
             provider, model, boot_epoch, status, started_at, lease_expires_at, last_heartbeat_at,
             request_blob_sha256, user_prompt_sha256, system_prompt_sha256, checkpoint_json, origin_kind,
             source_json, turn_provenance_json, task_barrier_task_id, delivery_barrier, pending_ids_json,
             metadata_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          attemptId,
          turnId,
          recoveredFromAttemptId,
          runId,
          sessionKey,
          sessionName,
          agentId,
          provider,
          model,
          bootEpoch,
          startedAt,
          leaseExpiresAt,
          lastHeartbeatAt,
          requestBlobSha256,
          userPromptSha256,
          systemPromptSha256,
          checkpointJson,
          originKind,
          sourceJson,
          provenanceJson,
          taskBarrierTaskId,
          deliveryBarrier,
          pendingIdsJson,
          metadataJson,
          startedAt,
          startedAt,
        );
      const row = getTurnAttemptRow(database, attemptId);
      if (!row) throw new CrashRecoveryLedgerNotFoundError(`Attempt ${attemptId} missing after insert`);
      return rowToTurnAttempt(row);
    },
    { label: "runtime-crash-recovery-create-attempt" },
  );
}

export function getRuntimeTurnAttempt(attemptId: string): RuntimeTurnAttemptRecord | null {
  const row = getTurnAttemptRow(getDb(), requiredText(attemptId, "attemptId"));
  return row ? rowToTurnAttempt(row) : null;
}

export function listRuntimeTurnAttempts(
  options: {
    bootEpoch?: string;
    sessionKey?: string;
    turnId?: string;
    status?: RuntimeTurnAttemptStatus;
    limit?: number;
  } = {},
): RuntimeTurnAttemptRecord[] {
  const where: string[] = [];
  const params: SQLQueryBindings[] = [];
  if (options.bootEpoch) {
    where.push("boot_epoch = ?");
    params.push(requiredText(options.bootEpoch, "bootEpoch"));
  }
  if (options.sessionKey) {
    where.push("session_key = ?");
    params.push(requiredText(options.sessionKey, "sessionKey"));
  }
  if (options.turnId) {
    where.push("turn_id = ?");
    params.push(requiredText(options.turnId, "turnId"));
  }
  if (options.status) {
    where.push("status = ?");
    params.push(options.status);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(`SELECT * FROM runtime_turn_attempts ${whereSql} ORDER BY started_at DESC, attempt_id DESC LIMIT ?`)
    .all(...params, assertLimit(options.limit)) as RuntimeTurnAttemptRow[];
  return rows.map(rowToTurnAttempt);
}

export function heartbeatRuntimeTurnAttempt(input: {
  attemptId: string;
  bootEpoch: string;
  heartbeatAt?: number;
  leaseExpiresAt: number;
}): RuntimeTurnAttemptRecord {
  const attemptId = requiredText(input.attemptId, "attemptId");
  const bootEpoch = requiredText(input.bootEpoch, "bootEpoch");
  const heartbeatAt = assertTimestamp(input.heartbeatAt ?? Date.now(), "heartbeatAt");
  const leaseExpiresAt = assertTimestamp(input.leaseExpiresAt, "leaseExpiresAt");
  if (leaseExpiresAt <= heartbeatAt) throw new Error("leaseExpiresAt must be after heartbeatAt");

  return executeWrite(
    getDb(),
    (database) => {
      const current = getTurnAttemptRow(database, attemptId);
      if (!current) throw new CrashRecoveryLedgerNotFoundError(`Attempt not found: ${attemptId}`);
      if (current.boot_epoch !== bootEpoch) {
        throw new CrashRecoveryLedgerConflictError(`Attempt ${attemptId} is owned by a different boot epoch`);
      }
      if (current.status !== "running") {
        throw new CrashRecoveryLedgerConflictError(`Cannot heartbeat terminal attempt ${attemptId}`);
      }
      if (current.recovery_claim_id !== null) {
        throw new CrashRecoveryLedgerConflictError(`Cannot heartbeat recovery-claimed attempt ${attemptId}`);
      }
      const boot = getBootEpochRow(database, bootEpoch);
      if (!boot || boot.status !== "active" || boot.lease_expires_at <= heartbeatAt) {
        throw new CrashRecoveryLedgerConflictError(`Cannot heartbeat attempt owned by inactive boot ${bootEpoch}`);
      }
      if (leaseExpiresAt > boot.lease_expires_at) {
        throw new CrashRecoveryLedgerConflictError("Attempt lease cannot outlive its owning boot lease");
      }
      if (
        heartbeatAt < current.last_heartbeat_at ||
        heartbeatAt < current.updated_at ||
        leaseExpiresAt < current.lease_expires_at
      ) {
        throw new CrashRecoveryLedgerConflictError(`Cannot move attempt ${attemptId} heartbeat or lease backwards`);
      }
      if (heartbeatAt === current.last_heartbeat_at && leaseExpiresAt === current.lease_expires_at) {
        return rowToTurnAttempt(current);
      }
      const result = database
        .prepare(
          `UPDATE runtime_turn_attempts
           SET last_heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
           WHERE attempt_id = ? AND boot_epoch = ? AND status = 'running' AND recovery_claim_id IS NULL`,
        )
        .run(heartbeatAt, leaseExpiresAt, heartbeatAt, attemptId, bootEpoch);
      if (result.changes !== 1) {
        throw new CrashRecoveryLedgerConflictError(`Attempt ${attemptId} lost its heartbeat fence`);
      }
      const row = getTurnAttemptRow(database, attemptId);
      if (!row) throw new CrashRecoveryLedgerNotFoundError(`Attempt not found after heartbeat: ${attemptId}`);
      return rowToTurnAttempt(row);
    },
    { label: "runtime-crash-recovery-heartbeat-attempt" },
  );
}

export function markRuntimeTurnAttemptSafety(input: {
  attemptId: string;
  startedTool?: true;
  materializedOutput?: true;
  inputMutated?: true;
  markedAt?: number;
}): RuntimeTurnAttemptRecord {
  if (!input.startedTool && !input.materializedOutput && !input.inputMutated) {
    throw new Error("At least one monotonic safety marker must be set");
  }
  const attemptId = requiredText(input.attemptId, "attemptId");
  const markedAt = assertTimestamp(input.markedAt ?? Date.now(), "markedAt");
  return executeWrite(
    getDb(),
    (database) => {
      const current = getTurnAttemptRow(database, attemptId);
      if (!current) throw new CrashRecoveryLedgerNotFoundError(`Attempt not found: ${attemptId}`);
      if (current.status !== "running") {
        throw new CrashRecoveryLedgerConflictError(`Cannot change safety markers on terminal attempt ${attemptId}`);
      }
      if (current.recovery_claim_id !== null) {
        throw new CrashRecoveryLedgerConflictError(
          `Cannot change safety markers on recovery-claimed attempt ${attemptId}`,
        );
      }
      if (markedAt < current.updated_at) {
        throw new CrashRecoveryLedgerConflictError(`Cannot move attempt ${attemptId} safety timestamp backwards`);
      }
      const currentMetadata = parseOptionalRecord(current.metadata_json, "runtime_turn_attempts.metadata_json");
      const metadataJson = input.inputMutated
        ? stringifyOptionalJson({
            ...(currentMetadata ?? {}),
            [RUNTIME_TURN_ATTEMPT_INPUT_MUTATED_METADATA_KEY]: true,
          })
        : current.metadata_json;
      const result = database
        .prepare(
          `UPDATE runtime_turn_attempts
           SET started_tool = MAX(started_tool, ?),
               materialized_output = MAX(materialized_output, ?),
               metadata_json = ?,
               updated_at = MAX(updated_at, ?)
           WHERE attempt_id = ? AND status = 'running' AND recovery_claim_id IS NULL`,
        )
        .run(input.startedTool ? 1 : 0, input.materializedOutput ? 1 : 0, metadataJson, markedAt, attemptId);
      if (result.changes !== 1) {
        throw new CrashRecoveryLedgerConflictError(`Attempt ${attemptId} lost its safety marker fence`);
      }
      const row = getTurnAttemptRow(database, attemptId);
      if (!row) throw new CrashRecoveryLedgerNotFoundError(`Attempt not found after safety update: ${attemptId}`);
      return rowToTurnAttempt(row);
    },
    { label: "runtime-crash-recovery-attempt-safety" },
  );
}

export function hasRuntimeTurnAttemptInputMutation(attempt: Pick<RuntimeTurnAttemptRecord, "metadata">): boolean {
  return attempt.metadata?.[RUNTIME_TURN_ATTEMPT_INPUT_MUTATED_METADATA_KEY] === true;
}

export function terminalizeRuntimeTurnAttempt(input: {
  attemptId: string;
  status: RuntimeTurnAttemptTerminalStatus;
  completedAt?: number;
  metadata?: JsonRecord | null;
}): RuntimeTurnAttemptRecord {
  const attemptId = requiredText(input.attemptId, "attemptId");
  const completedAt = assertTimestamp(input.completedAt ?? Date.now(), "completedAt");
  return executeWrite(
    getDb(),
    (database) => {
      const current = getTurnAttemptRow(database, attemptId);
      if (!current) throw new CrashRecoveryLedgerNotFoundError(`Attempt not found: ${attemptId}`);
      if (current.status === input.status) {
        if (input.completedAt !== undefined && completedAt !== current.completed_at) {
          throw new CrashRecoveryLedgerConflictError(`Attempt ${attemptId} already has a different completion time`);
        }
        if (input.metadata !== undefined && input.metadata !== null) {
          const existingMetadata =
            parseOptionalRecord(current.metadata_json, "runtime_turn_attempts.metadata_json") ?? {};
          const retriedMetadata = stringifyOptionalJson({ ...existingMetadata, ...input.metadata });
          if (retriedMetadata !== current.metadata_json) {
            throw new CrashRecoveryLedgerConflictError(`Attempt ${attemptId} already has different terminal metadata`);
          }
        }
        return rowToTurnAttempt(current);
      }
      if (current.status !== "running") {
        throw new CrashRecoveryLedgerConflictError(
          `Cannot transition attempt ${attemptId} from ${current.status} to ${input.status}`,
        );
      }
      if (current.recovery_claim_id !== null) {
        throw new CrashRecoveryLedgerConflictError(`Cannot terminalize recovery-claimed attempt ${attemptId}`);
      }
      if (completedAt < current.last_heartbeat_at || completedAt < current.updated_at) {
        throw new CrashRecoveryLedgerConflictError("completedAt cannot precede the latest attempt observation");
      }
      const existingMetadata = parseOptionalRecord(current.metadata_json, "runtime_turn_attempts.metadata_json") ?? {};
      const metadataJson = stringifyOptionalJson(
        input.metadata === undefined || input.metadata === null
          ? existingMetadata
          : { ...existingMetadata, ...input.metadata },
      );
      const result = database
        .prepare(
          `UPDATE runtime_turn_attempts
           SET status = ?, completed_at = ?, metadata_json = ?, updated_at = ?
           WHERE attempt_id = ? AND status = 'running' AND recovery_claim_id IS NULL`,
        )
        .run(input.status, completedAt, metadataJson, completedAt, attemptId);
      if (result.changes !== 1) {
        throw new CrashRecoveryLedgerConflictError(`Attempt ${attemptId} lost its terminal transition race`);
      }
      const row = getTurnAttemptRow(database, attemptId);
      if (!row) throw new CrashRecoveryLedgerNotFoundError(`Attempt not found after terminal transition: ${attemptId}`);
      return rowToTurnAttempt(row);
    },
    { label: "runtime-crash-recovery-terminalize-attempt" },
  );
}

function promptQueueFingerprint(input: {
  dedupeKey: string;
  sessionKey: string;
  sessionName: string | null;
  agentId: string | null;
  laneKey: DeliveryBarrier;
  originKind: TurnOrigin;
  deliveryBarrier: DeliveryBarrier;
  taskBarrierTaskId: string | null;
  pendingId: string | null;
  promptJson: string;
  runtimeMessageJson: string;
  metadataJson: string | null;
}): string {
  return sha256(
    stringifyRequiredJson(
      {
        dedupeKey: input.dedupeKey,
        sessionKey: input.sessionKey,
        sessionName: input.sessionName,
        agentId: input.agentId,
        laneKey: input.laneKey,
        originKind: input.originKind,
        deliveryBarrier: input.deliveryBarrier,
        taskBarrierTaskId: input.taskBarrierTaskId,
        pendingId: input.pendingId,
        prompt: parseRequiredJson(input.promptJson, "prompt fingerprint"),
        runtimeMessage: parseRequiredJson(input.runtimeMessageJson, "runtime message fingerprint"),
        metadata: parseOptionalJson(input.metadataJson, "metadata fingerprint"),
      },
      "prompt queue fingerprint",
    ),
  );
}

export function enqueueRuntimePrompt(input: EnqueueRuntimePromptInput): {
  created: boolean;
  item: RuntimePromptQueueRecord;
} {
  const requestedQueueItemId = optionalText(input.queueItemId);
  const dedupeKey = requiredText(input.dedupeKey, "dedupeKey");
  const sessionKey = requiredText(input.sessionKey, "sessionKey");
  const sessionName = optionalText(input.sessionName);
  const agentId = optionalText(input.agentId);
  const laneKey = requireDeliveryBarrier(input.laneKey, "laneKey");
  const bootEpoch = optionalText(input.bootEpoch);
  const originKind = requireTurnOrigin(input.originKind, "originKind");
  const deliveryBarrier = requireDeliveryBarrier(input.deliveryBarrier, "deliveryBarrier");
  const taskBarrierTaskId = optionalText(input.taskBarrierTaskId);
  const pendingId = optionalText(input.pendingId);
  const promptJson = stringifyRequiredJson(input.prompt, "prompt");
  const runtimeMessageJson = stringifyRequiredJson(input.runtimeMessage, "runtimeMessage");
  const queuedAt = assertTimestamp(input.queuedAt ?? Date.now(), "queuedAt");
  const metadataJson = stringifyOptionalJson(input.metadata);
  const immutableFingerprint = promptQueueFingerprint({
    dedupeKey,
    sessionKey,
    sessionName,
    agentId,
    laneKey,
    originKind,
    deliveryBarrier,
    taskBarrierTaskId,
    pendingId,
    promptJson,
    runtimeMessageJson,
    metadataJson,
  });

  return executeWrite(
    getDb(),
    (database) => {
      const existing = database.prepare("SELECT * FROM runtime_prompt_queue WHERE dedupe_key = ?").get(dedupeKey) as
        | RuntimePromptQueueRow
        | undefined;
      if (existing) {
        if (existing.immutable_fingerprint !== immutableFingerprint) {
          throw new CrashRecoveryLedgerConflictError(
            `Prompt dedupe key ${dedupeKey} already exists with different immutable content`,
          );
        }
        if (requestedQueueItemId && existing.queue_item_id !== requestedQueueItemId) {
          throw new CrashRecoveryLedgerConflictError(
            `Prompt dedupe key ${dedupeKey} already belongs to queue item ${existing.queue_item_id}`,
          );
        }
        return { created: false, item: rowToPromptQueue(existing) };
      }
      if (bootEpoch) {
        const boot = getBootEpochRow(database, bootEpoch);
        if (!boot) throw new CrashRecoveryLedgerNotFoundError(`Queue boot epoch not found: ${bootEpoch}`);
        if (boot.status !== "active") {
          throw new CrashRecoveryLedgerConflictError(`Cannot enqueue from terminal boot epoch ${bootEpoch}`);
        }
        if (queuedAt < boot.started_at || boot.lease_expires_at <= queuedAt) {
          throw new CrashRecoveryLedgerConflictError(`Cannot enqueue outside the live lease for boot ${bootEpoch}`);
        }
      }
      const queueItemId = requestedQueueItemId ?? `queue_${randomUUID()}`;
      database
        .prepare(
          `INSERT INTO runtime_prompt_queue (
             queue_item_id, dedupe_key, immutable_fingerprint, session_key, session_name, agent_id,
             lane_key, boot_epoch, status, origin_kind, delivery_barrier, task_barrier_task_id,
             pending_id, prompt_json, runtime_message_json, queued_at, metadata_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          queueItemId,
          dedupeKey,
          immutableFingerprint,
          sessionKey,
          sessionName,
          agentId,
          laneKey,
          bootEpoch,
          originKind,
          deliveryBarrier,
          taskBarrierTaskId,
          pendingId,
          promptJson,
          runtimeMessageJson,
          queuedAt,
          metadataJson,
          queuedAt,
          queuedAt,
        );
      const row = getPromptQueueRow(database, queueItemId);
      if (!row) throw new CrashRecoveryLedgerNotFoundError(`Prompt queue item ${queueItemId} missing after insert`);
      return { created: true, item: rowToPromptQueue(row) };
    },
    { label: "runtime-crash-recovery-enqueue-prompt" },
  );
}

export function getRuntimePromptQueueItem(queueItemId: string): RuntimePromptQueueRecord | null {
  const row = getPromptQueueRow(getDb(), requiredText(queueItemId, "queueItemId"));
  return row ? rowToPromptQueue(row) : null;
}

export function listRuntimePromptQueue(
  options: {
    sessionKey?: string;
    laneKey?: DeliveryBarrier;
    statuses?: RuntimePromptQueueStatus[];
    limit?: number;
  } = {},
): RuntimePromptQueueRecord[] {
  const where: string[] = [];
  const params: SQLQueryBindings[] = [];
  if (options.sessionKey) {
    where.push("session_key = ?");
    params.push(requiredText(options.sessionKey, "sessionKey"));
  }
  if (options.laneKey) {
    where.push("lane_key = ?");
    params.push(options.laneKey);
  }
  if (options.statuses?.length) {
    where.push(`status IN (${options.statuses.map(() => "?").join(", ")})`);
    params.push(...options.statuses);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(`SELECT * FROM runtime_prompt_queue ${whereSql} ORDER BY queue_sequence ASC LIMIT ?`)
    .all(...params, assertLimit(options.limit)) as RuntimePromptQueueRow[];
  return rows.map(rowToPromptQueue);
}

export function compareAndSetRuntimePromptQueueStatus(input: {
  queueItemId: string;
  expectedStatus: RuntimePromptQueueStatus | RuntimePromptQueueStatus[];
  expectedBootEpoch?: string | null;
  expectedLeaseOwner?: string | null;
  expectedLeaseExpiresAt?: number | null;
  status: RuntimePromptQueueStatus;
  bootEpoch?: string | null;
  leaseOwner?: string | null;
  leaseExpiresAt?: number | null;
  deliveredAttemptId?: string | null;
  deliveredTurnId?: string | null;
  completedAt?: number | null;
  updatedAt?: number;
}): { applied: boolean; item: RuntimePromptQueueRecord } {
  const queueItemId = requiredText(input.queueItemId, "queueItemId");
  const expected = Array.isArray(input.expectedStatus) ? input.expectedStatus : [input.expectedStatus];
  if (expected.length === 0) throw new Error("expectedStatus cannot be empty");
  const updatedAt = assertTimestamp(input.updatedAt ?? Date.now(), "updatedAt");

  return executeWrite(
    getDb(),
    (database) => {
      const current = getPromptQueueRow(database, queueItemId);
      if (!current) throw new CrashRecoveryLedgerNotFoundError(`Prompt queue item not found: ${queueItemId}`);
      const currentRecord = rowToPromptQueue(current);
      const currentStatus = currentRecord.status;
      if (current.recovery_claim_id !== null) {
        throw new CrashRecoveryLedgerConflictError(`Cannot mutate recovery-claimed prompt queue item ${queueItemId}`);
      }
      if (!expected.includes(currentStatus)) return { applied: false, item: currentRecord };
      const metadataJson = current.metadata_json;

      if (TERMINAL_QUEUE_STATUSES.has(currentStatus)) {
        if (currentStatus !== input.status) {
          throw new CrashRecoveryLedgerConflictError(
            `Cannot transition terminal prompt queue item ${queueItemId} from ${currentStatus} to ${input.status}`,
          );
        }
        const providedValuesMatch =
          (input.bootEpoch === undefined || optionalText(input.bootEpoch) === current.boot_epoch) &&
          (input.leaseOwner === undefined || optionalText(input.leaseOwner) === current.lease_owner) &&
          (input.leaseExpiresAt === undefined || input.leaseExpiresAt === current.lease_expires_at) &&
          (input.deliveredAttemptId === undefined ||
            optionalText(input.deliveredAttemptId) === current.delivered_attempt_id) &&
          (input.deliveredTurnId === undefined || optionalText(input.deliveredTurnId) === current.delivered_turn_id) &&
          (input.completedAt === undefined || input.completedAt === current.completed_at) &&
          (input.updatedAt === undefined || input.updatedAt === current.updated_at) &&
          metadataJson === current.metadata_json;
        if (!providedValuesMatch) {
          throw new CrashRecoveryLedgerConflictError(
            `Terminal prompt queue item ${queueItemId} already has different durable data`,
          );
        }
        return { applied: false, item: currentRecord };
      }
      if (!ALLOWED_QUEUE_STATUS_TRANSITIONS[currentStatus].has(input.status)) {
        throw new CrashRecoveryLedgerConflictError(
          `Cannot transition prompt queue item ${queueItemId} from ${currentStatus} to ${input.status}`,
        );
      }
      if (currentStatus === "delivered" && input.status === "delivered") {
        const providedValuesMatch =
          (input.bootEpoch === undefined || optionalText(input.bootEpoch) === current.boot_epoch) &&
          (input.leaseOwner === undefined || optionalText(input.leaseOwner) === current.lease_owner) &&
          (input.leaseExpiresAt === undefined || input.leaseExpiresAt === current.lease_expires_at) &&
          (input.deliveredAttemptId === undefined ||
            optionalText(input.deliveredAttemptId) === current.delivered_attempt_id) &&
          (input.deliveredTurnId === undefined || optionalText(input.deliveredTurnId) === current.delivered_turn_id) &&
          (input.completedAt === undefined || input.completedAt === current.completed_at) &&
          metadataJson === current.metadata_json;
        if (!providedValuesMatch) {
          throw new CrashRecoveryLedgerConflictError(
            `Delivered prompt queue item ${queueItemId} already has different durable data`,
          );
        }
        return { applied: false, item: currentRecord };
      }
      if (updatedAt < current.updated_at) {
        throw new CrashRecoveryLedgerConflictError(`Cannot move prompt queue item ${queueItemId} time backwards`);
      }

      if (current.lease_owner !== null) {
        if (
          input.expectedBootEpoch === undefined ||
          input.expectedLeaseOwner === undefined ||
          input.expectedLeaseExpiresAt === undefined
        ) {
          throw new Error("Owner-bound prompt queue transition requires the observed boot, owner, and lease fence");
        }
        const expectedBootEpoch = optionalText(input.expectedBootEpoch);
        const expectedLeaseOwner = optionalText(input.expectedLeaseOwner);
        const expectedLeaseExpiresAt = input.expectedLeaseExpiresAt;
        if (
          expectedBootEpoch !== current.boot_epoch ||
          expectedLeaseOwner !== current.lease_owner ||
          expectedLeaseExpiresAt !== current.lease_expires_at
        ) {
          return { applied: false, item: currentRecord };
        }
      }

      let nextBootEpoch = input.bootEpoch === undefined ? current.boot_epoch : optionalText(input.bootEpoch);
      let nextLeaseOwner = input.leaseOwner === undefined ? current.lease_owner : optionalText(input.leaseOwner);
      let nextLeaseExpiresAt = input.leaseExpiresAt === undefined ? current.lease_expires_at : input.leaseExpiresAt;
      const nextDeliveredAttemptId =
        input.deliveredAttemptId === undefined ? current.delivered_attempt_id : optionalText(input.deliveredAttemptId);
      const nextDeliveredTurnId =
        input.deliveredTurnId === undefined ? current.delivered_turn_id : optionalText(input.deliveredTurnId);
      let nextCompletedAt = input.completedAt === undefined ? current.completed_at : input.completedAt;

      if (["queued", "requeued", "deferred"].includes(input.status)) {
        nextBootEpoch = null;
        nextLeaseOwner = null;
        nextLeaseExpiresAt = null;
      }
      if (input.status === "leased" || input.status === "starting") {
        if (!nextBootEpoch || !nextLeaseOwner || nextLeaseExpiresAt === null) {
          throw new CrashRecoveryLedgerConflictError(
            `${input.status} prompt queue item requires bootEpoch, leaseOwner, and leaseExpiresAt`,
          );
        }
        const leaseExpiresAt = assertTimestamp(nextLeaseExpiresAt, "leaseExpiresAt");
        if (leaseExpiresAt <= updatedAt) {
          throw new CrashRecoveryLedgerConflictError(`${input.status} prompt queue lease must expire in the future`);
        }
      }
      if (input.status === "delivered") {
        if (!nextBootEpoch || !nextLeaseOwner || nextLeaseExpiresAt === null) {
          throw new CrashRecoveryLedgerConflictError(
            "Delivered prompt queue item requires bootEpoch, leaseOwner, and leaseExpiresAt",
          );
        }
        if (!nextDeliveredAttemptId || !nextDeliveredTurnId) {
          throw new CrashRecoveryLedgerConflictError(
            "Delivered prompt queue item requires deliveredAttemptId and deliveredTurnId",
          );
        }
        if (assertTimestamp(nextLeaseExpiresAt, "leaseExpiresAt") <= updatedAt) {
          throw new CrashRecoveryLedgerConflictError("Cannot deliver a prompt queue item after its lease expires");
        }
      }
      if (TERMINAL_QUEUE_STATUSES.has(input.status)) {
        nextCompletedAt = assertTimestamp(nextCompletedAt ?? updatedAt, "completedAt");
        if (
          nextCompletedAt < current.updated_at ||
          nextCompletedAt < current.queued_at ||
          updatedAt < nextCompletedAt
        ) {
          throw new CrashRecoveryLedgerConflictError("Prompt queue completion would create a regressive timeline");
        }
      } else if (nextCompletedAt !== null) {
        throw new CrashRecoveryLedgerConflictError(`Non-terminal queue status ${input.status} cannot have completedAt`);
      }
      if (nextLeaseExpiresAt !== null) assertTimestamp(nextLeaseExpiresAt, "leaseExpiresAt");
      if (nextBootEpoch) {
        const boot = getBootEpochRow(database, nextBootEpoch);
        if (!boot) throw new CrashRecoveryLedgerNotFoundError(`Queue boot epoch not found: ${nextBootEpoch}`);
        if (
          ["leased", "starting", "delivered"].includes(input.status) &&
          (boot.status !== "active" || boot.lease_expires_at <= updatedAt)
        ) {
          throw new CrashRecoveryLedgerConflictError(
            `Cannot assign prompt queue item to inactive boot ${nextBootEpoch}`,
          );
        }
        if (nextLeaseExpiresAt !== null && nextLeaseExpiresAt > boot.lease_expires_at) {
          throw new CrashRecoveryLedgerConflictError("Prompt queue lease cannot outlive its owning boot lease");
        }
      }
      if (nextDeliveredAttemptId) {
        const attempt = getTurnAttemptRow(database, nextDeliveredAttemptId);
        if (!attempt) {
          throw new CrashRecoveryLedgerNotFoundError(`Delivered attempt not found: ${nextDeliveredAttemptId}`);
        }
        rowToTurnAttempt(attempt);
        if (input.status === "delivered") {
          if (attempt.status !== "running") {
            throw new CrashRecoveryLedgerConflictError("Cannot deliver a prompt queue item to a terminal attempt");
          }
          if (attempt.recovery_claim_id !== null) {
            throw new CrashRecoveryLedgerConflictError(
              "Cannot deliver a prompt queue item to a recovery-claimed attempt",
            );
          }
          if (attempt.lease_expires_at <= updatedAt) {
            throw new CrashRecoveryLedgerConflictError("Cannot deliver a prompt queue item to an expired attempt");
          }
          if (updatedAt < attempt.updated_at) {
            throw new CrashRecoveryLedgerConflictError("Prompt delivery cannot precede its attempt observation");
          }
        }
        if (nextDeliveredTurnId && attempt.turn_id !== nextDeliveredTurnId) {
          throw new CrashRecoveryLedgerConflictError("Delivered attempt and delivered turn do not match");
        }
        if (attempt.session_key !== current.session_key) {
          throw new CrashRecoveryLedgerConflictError("Delivered attempt and prompt queue session do not match");
        }
        if (nextBootEpoch && attempt.boot_epoch !== nextBootEpoch) {
          throw new CrashRecoveryLedgerConflictError("Delivered attempt and prompt queue boot owner do not match");
        }
      }

      const result = database
        .prepare(
          `UPDATE runtime_prompt_queue
           SET status = ?, boot_epoch = ?, lease_owner = ?, lease_expires_at = ?,
               delivered_attempt_id = ?, delivered_turn_id = ?, completed_at = ?, metadata_json = ?, updated_at = ?
           WHERE queue_item_id = ? AND status = ? AND recovery_claim_id IS NULL`,
        )
        .run(
          input.status,
          nextBootEpoch,
          nextLeaseOwner,
          nextLeaseExpiresAt,
          nextDeliveredAttemptId,
          nextDeliveredTurnId,
          nextCompletedAt,
          metadataJson,
          updatedAt,
          queueItemId,
          currentStatus,
        );
      if (result.changes !== 1) {
        throw new CrashRecoveryLedgerConflictError(`Prompt queue item ${queueItemId} lost its transition race`);
      }
      const row = getPromptQueueRow(database, queueItemId);
      if (!row)
        throw new CrashRecoveryLedgerNotFoundError(`Prompt queue item missing after transition: ${queueItemId}`);
      return { applied: true, item: rowToPromptQueue(row) };
    },
    { label: "runtime-crash-recovery-cas-prompt" },
  );
}

export function createRuntimeRecoveryRun(input: {
  recoveryRunId?: string;
  mode: RuntimeRecoveryRunMode;
  bootEpoch?: string | null;
  startedAt?: number;
  metadata?: JsonRecord | null;
}): RuntimeRecoveryRunRecord {
  const recoveryRunId = requiredText(input.recoveryRunId ?? `recovery_${randomUUID()}`, "recoveryRunId");
  const bootEpoch = optionalText(input.bootEpoch);
  const startedAt = assertTimestamp(input.startedAt ?? Date.now(), "startedAt");
  const metadataJson = stringifyOptionalJson(input.metadata);

  return executeWrite(
    getDb(),
    (database) => {
      const existing = getRecoveryRunRow(database, recoveryRunId);
      if (existing) {
        const matches =
          existing.mode === input.mode &&
          existing.boot_epoch === bootEpoch &&
          existing.started_at === startedAt &&
          existing.metadata_json === metadataJson;
        if (!matches) {
          throw new CrashRecoveryLedgerConflictError(
            `Recovery run ${recoveryRunId} already exists with different immutable data`,
          );
        }
        return rowToRecoveryRun(existing);
      }
      if (bootEpoch) {
        const boot = getBootEpochRow(database, bootEpoch);
        if (!boot) throw new CrashRecoveryLedgerNotFoundError(`Recovery boot epoch not found: ${bootEpoch}`);
        if (
          input.mode === "apply" &&
          (boot.status !== "active" || startedAt < boot.started_at || boot.lease_expires_at <= startedAt)
        ) {
          throw new CrashRecoveryLedgerConflictError(`Apply recovery run requires an active boot epoch`);
        }
      } else if (input.mode === "apply") {
        throw new CrashRecoveryLedgerConflictError("Apply recovery run requires bootEpoch");
      }

      database
        .prepare(
          `INSERT INTO runtime_recovery_runs (
             recovery_run_id, mode, boot_epoch, status, started_at, metadata_json, created_at, updated_at
           ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`,
        )
        .run(recoveryRunId, input.mode, bootEpoch, startedAt, metadataJson, startedAt, startedAt);
      const row = getRecoveryRunRow(database, recoveryRunId);
      if (!row) throw new CrashRecoveryLedgerNotFoundError(`Recovery run ${recoveryRunId} missing after insert`);
      return rowToRecoveryRun(row);
    },
    { label: "runtime-crash-recovery-create-run" },
  );
}

export function getRuntimeRecoveryRun(recoveryRunId: string): RuntimeRecoveryRunRecord | null {
  const row = getRecoveryRunRow(getDb(), requiredText(recoveryRunId, "recoveryRunId"));
  return row ? rowToRecoveryRun(row) : null;
}

export function listRuntimeRecoveryRuns(
  options: { mode?: RuntimeRecoveryRunMode; status?: RuntimeRecoveryRunStatus; limit?: number } = {},
): RuntimeRecoveryRunRecord[] {
  const where: string[] = [];
  const params: SQLQueryBindings[] = [];
  if (options.mode) {
    where.push("mode = ?");
    params.push(options.mode);
  }
  if (options.status) {
    where.push("status = ?");
    params.push(options.status);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(`SELECT * FROM runtime_recovery_runs ${whereSql} ORDER BY started_at DESC, recovery_run_id DESC LIMIT ?`)
    .all(...params, assertLimit(options.limit)) as RuntimeRecoveryRunRow[];
  return rows.map(rowToRecoveryRun);
}

export function completeRuntimeRecoveryRun(input: {
  recoveryRunId: string;
  status: Exclude<RuntimeRecoveryRunStatus, "running">;
  summary?: JsonRecord | null;
  error?: string | null;
  completedAt?: number;
}): RuntimeRecoveryRunRecord {
  const recoveryRunId = requiredText(input.recoveryRunId, "recoveryRunId");
  const completedAt = assertTimestamp(input.completedAt ?? Date.now(), "completedAt");
  const summaryJson = stringifyOptionalJson(input.summary);
  const error = optionalText(input.error);
  if (input.status === "failed" && !error) throw new Error("Failed recovery run requires an error");
  if (input.status === "complete" && error) throw new Error("Completed recovery run cannot include an error");

  return executeWrite(
    getDb(),
    (database) => {
      const current = getRecoveryRunRow(database, recoveryRunId);
      if (!current) throw new CrashRecoveryLedgerNotFoundError(`Recovery run not found: ${recoveryRunId}`);
      rowToRecoveryRun(current);
      const candidateRows = database
        .prepare("SELECT * FROM runtime_recovery_candidates WHERE recovery_run_id = ?")
        .all(recoveryRunId) as RuntimeRecoveryCandidateRow[];
      const candidates = candidateRows.map(rowToRecoveryCandidate);
      if (current.status === input.status) {
        const sameCompletion = input.completedAt === undefined || completedAt === current.completed_at;
        const sameSummary = input.summary === undefined || summaryJson === current.summary_json;
        const sameError = input.error === undefined || error === current.error;
        if (!sameCompletion || !sameSummary || !sameError) {
          throw new CrashRecoveryLedgerConflictError(
            `Recovery run ${recoveryRunId} already has different terminal data`,
          );
        }
        return rowToRecoveryRun(current);
      }
      if (current.status !== "running") {
        throw new CrashRecoveryLedgerConflictError(
          `Cannot transition recovery run ${recoveryRunId} from ${current.status} to ${input.status}`,
        );
      }
      if (completedAt < current.updated_at) {
        throw new CrashRecoveryLedgerConflictError("completedAt cannot precede the latest recovery run update");
      }
      const openCandidate = candidates.find(
        (candidate) => candidate.actionStatus === "pending" || candidate.actionStatus === "claimed",
      );
      if (openCandidate) {
        throw new CrashRecoveryLedgerConflictError(
          `Recovery run ${recoveryRunId} still has open candidate ${openCandidate.candidateKey}`,
        );
      }
      const latestCandidateUpdatedAt = candidates.reduce<number | null>(
        (latest, candidate) => (latest === null ? candidate.updatedAt : Math.max(latest, candidate.updatedAt)),
        null,
      );
      if (latestCandidateUpdatedAt !== null && completedAt < latestCandidateUpdatedAt) {
        throw new CrashRecoveryLedgerConflictError("completedAt cannot precede the latest candidate update");
      }
      const result = database
        .prepare(
          `UPDATE runtime_recovery_runs
           SET status = ?, completed_at = ?, summary_json = ?, error = ?, updated_at = ?
           WHERE recovery_run_id = ? AND status = 'running'`,
        )
        .run(input.status, completedAt, summaryJson, error, completedAt, recoveryRunId);
      if (result.changes !== 1) {
        throw new CrashRecoveryLedgerConflictError(`Recovery run ${recoveryRunId} lost its terminal transition race`);
      }
      const row = getRecoveryRunRow(database, recoveryRunId);
      if (!row) throw new CrashRecoveryLedgerNotFoundError(`Recovery run missing after completion: ${recoveryRunId}`);
      return rowToRecoveryRun(row);
    },
    { label: "runtime-crash-recovery-complete-run" },
  );
}

export function recordRuntimeRecoveryCandidate(
  input: RecordRuntimeRecoveryCandidateInput,
): RuntimeRecoveryCandidateRecord {
  const recoveryRunId = requiredText(input.recoveryRunId, "recoveryRunId");
  const requestedCandidateKey = optionalText(input.candidateKey);
  const sessionKey = requiredText(input.sessionKey, "sessionKey");
  let sessionName = optionalText(input.sessionName);
  let attemptId = optionalText(input.attemptId);
  let turnId = optionalText(input.turnId);
  let queueItemId = optionalText(input.queueItemId);
  const reasonCode = requiredText(input.reasonCode, "reasonCode");
  const action = requiredText(input.action, "action");
  const detailsJson = stringifyOptionalJson(input.details);
  const recordedAt = assertTimestamp(input.recordedAt ?? Date.now(), "recordedAt");

  return executeWrite(
    getDb(),
    (database) => {
      const run = getRecoveryRunRow(database, recoveryRunId);
      if (!run) throw new CrashRecoveryLedgerNotFoundError(`Recovery run not found: ${recoveryRunId}`);
      rowToRecoveryRun(run);
      if (run.status !== "running") {
        throw new CrashRecoveryLedgerConflictError(`Cannot append candidate to terminal recovery run ${recoveryRunId}`);
      }
      if (recordedAt < run.started_at) {
        throw new CrashRecoveryLedgerConflictError("Recovery candidate cannot precede its recovery run");
      }

      if (input.candidateType === "turn_attempt") {
        if (!attemptId || queueItemId) {
          throw new Error("turn_attempt candidate requires attemptId and forbids queueItemId");
        }
        const attempt = getTurnAttemptRow(database, attemptId);
        if (!attempt) throw new CrashRecoveryLedgerNotFoundError(`Candidate attempt not found: ${attemptId}`);
        rowToTurnAttempt(attempt);
        if (attempt.session_key !== sessionKey) {
          throw new CrashRecoveryLedgerConflictError("Candidate sessionKey does not match attempt sessionKey");
        }
        if (turnId && turnId !== attempt.turn_id) {
          throw new CrashRecoveryLedgerConflictError("Candidate turnId does not match attempt turnId");
        }
        turnId = attempt.turn_id;
        sessionName ??= attempt.session_name;
        queueItemId = null;
      } else if (input.candidateType === "prompt_queue") {
        if (!queueItemId || attemptId) {
          throw new Error("prompt_queue candidate requires queueItemId and forbids attemptId");
        }
        const queueItem = getPromptQueueRow(database, queueItemId);
        if (!queueItem) throw new CrashRecoveryLedgerNotFoundError(`Candidate queue item not found: ${queueItemId}`);
        rowToPromptQueue(queueItem);
        if (queueItem.session_key !== sessionKey) {
          throw new CrashRecoveryLedgerConflictError("Candidate sessionKey does not match queue item sessionKey");
        }
        if (turnId && queueItem.delivered_turn_id && turnId !== queueItem.delivered_turn_id) {
          throw new CrashRecoveryLedgerConflictError("Candidate turnId does not match queue item delivered turnId");
        }
        turnId ??= queueItem.delivered_turn_id;
        sessionName ??= queueItem.session_name;
        attemptId = null;
      } else {
        if (!turnId || attemptId || queueItemId) {
          throw new Error("legacy_session_turn candidate requires turnId and forbids attemptId and queueItemId");
        }
      }

      const candidateKey = buildRuntimeRecoveryCandidateKey({
        candidateType: input.candidateType,
        sessionKey,
        attemptId,
        turnId,
        queueItemId,
      });
      if (requestedCandidateKey && requestedCandidateKey !== candidateKey) {
        throw new CrashRecoveryLedgerConflictError(
          `Recovery candidate key must be canonical: expected ${candidateKey}`,
        );
      }
      const claimable = run.mode === "apply" && input.candidateType !== "legacy_session_turn";
      const actionStatus: RuntimeRecoveryActionStatus = claimable ? "pending" : "not_applied";
      const actionCompletedAt = claimable ? null : recordedAt;
      const existing = getRecoveryCandidateRow(database, recoveryRunId, candidateKey);
      if (existing) {
        const matches =
          existing.candidate_type === input.candidateType &&
          existing.session_key === sessionKey &&
          existing.session_name === sessionName &&
          existing.attempt_id === attemptId &&
          existing.turn_id === turnId &&
          existing.queue_item_id === queueItemId &&
          existing.decision === input.decision &&
          existing.reason_code === reasonCode &&
          existing.action === action &&
          existing.details_json === detailsJson;
        if (!matches) {
          throw new CrashRecoveryLedgerConflictError(
            `Recovery candidate ${candidateKey} already exists in run ${recoveryRunId} with different immutable data`,
          );
        }
        return rowToRecoveryCandidate(existing);
      }

      database
        .prepare(
          `INSERT INTO runtime_recovery_candidates (
             recovery_run_id, candidate_key, candidate_type, session_key, session_name, attempt_id,
             turn_id, queue_item_id, decision, reason_code, action, action_status, details_json,
             action_completed_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          recoveryRunId,
          candidateKey,
          input.candidateType,
          sessionKey,
          sessionName,
          attemptId,
          turnId,
          queueItemId,
          input.decision,
          reasonCode,
          action,
          actionStatus,
          detailsJson,
          actionCompletedAt,
          recordedAt,
          recordedAt,
        );
      const row = getRecoveryCandidateRow(database, recoveryRunId, candidateKey);
      if (!row) {
        throw new CrashRecoveryLedgerNotFoundError(
          `Recovery candidate ${candidateKey} missing after insert in run ${recoveryRunId}`,
        );
      }
      return rowToRecoveryCandidate(row);
    },
    { label: "runtime-crash-recovery-record-candidate" },
  );
}

export function getRuntimeRecoveryCandidate(
  recoveryRunId: string,
  candidateKey: string,
): RuntimeRecoveryCandidateRecord | null {
  const row = getRecoveryCandidateRow(
    getDb(),
    requiredText(recoveryRunId, "recoveryRunId"),
    requiredText(candidateKey, "candidateKey"),
  );
  return row ? rowToRecoveryCandidate(row) : null;
}

export function listRuntimeRecoveryCandidates(recoveryRunId: string): RuntimeRecoveryCandidateRecord[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM runtime_recovery_candidates
       WHERE recovery_run_id = ?
       ORDER BY created_at ASC, candidate_key ASC`,
    )
    .all(requiredText(recoveryRunId, "recoveryRunId")) as RuntimeRecoveryCandidateRow[];
  return rows.map(rowToRecoveryCandidate);
}

export function acquireRuntimeRecoveryClaim(input: {
  recoveryRunId: string;
  candidateKey: string;
  claimedByBootEpoch: string;
  claimId?: string;
  claimedAt?: number;
}): { status: "acquired" | "existing"; claim: RuntimeRecoveryClaimRecord } {
  const recoveryRunId = requiredText(input.recoveryRunId, "recoveryRunId");
  const candidateKey = requiredText(input.candidateKey, "candidateKey");
  const claimedByBootEpoch = requiredText(input.claimedByBootEpoch, "claimedByBootEpoch");
  const requestedClaimId = requiredText(input.claimId ?? `claim_${randomUUID()}`, "claimId");
  const claimedAt = assertTimestamp(input.claimedAt ?? Date.now(), "claimedAt");

  return executeWrite(
    getDb(),
    (database) => {
      const run = getRecoveryRunRow(database, recoveryRunId);
      if (!run) throw new CrashRecoveryLedgerNotFoundError(`Recovery run not found: ${recoveryRunId}`);
      rowToRecoveryRun(run);
      if (run.mode !== "apply" || run.status !== "running") {
        throw new CrashRecoveryLedgerConflictError("Only a running apply recovery run may acquire claims");
      }
      const boot = getBootEpochRow(database, claimedByBootEpoch);
      if (!boot) throw new CrashRecoveryLedgerNotFoundError(`Claiming boot epoch not found: ${claimedByBootEpoch}`);
      rowToBootEpoch(boot);
      if (boot.status !== "active" || boot.lease_expires_at <= claimedAt) {
        throw new CrashRecoveryLedgerConflictError("Recovery claim requires an active claiming boot epoch");
      }
      if (run.boot_epoch !== claimedByBootEpoch) {
        throw new CrashRecoveryLedgerConflictError("Recovery claim must be owned by the apply run boot epoch");
      }
      const candidate = getRecoveryCandidateRow(database, recoveryRunId, candidateKey);
      if (!candidate) {
        throw new CrashRecoveryLedgerNotFoundError(
          `Recovery candidate ${candidateKey} not found in run ${recoveryRunId}`,
        );
      }
      rowToRecoveryCandidate(candidate);
      if (candidate.candidate_type === "legacy_session_turn") {
        throw new CrashRecoveryLedgerConflictError(
          "Legacy session turn candidates are inspect-only and cannot be claimed",
        );
      }
      if (claimedAt < candidate.updated_at || claimedAt < run.started_at) {
        throw new CrashRecoveryLedgerConflictError("Recovery claim cannot precede its run or candidate");
      }

      const existing = getRecoveryClaimByCandidateRow(database, candidateKey);
      if (existing) {
        const sameLogicalCandidate =
          existing.candidate_type === candidate.candidate_type &&
          existing.session_key === candidate.session_key &&
          existing.attempt_id === candidate.attempt_id &&
          existing.queue_item_id === candidate.queue_item_id;
        if (!sameLogicalCandidate) {
          throw new CrashRecoveryLedgerConflictError(
            `Recovery candidate key ${candidateKey} collides with a different logical source`,
          );
        }
        if (candidate.action_status === "pending") {
          const resultJson = stringifyRequiredJson(
            {
              code: "already_claimed",
              claimId: existing.claim_id,
              recoveryRunId: existing.recovery_run_id,
            },
            "existing claim result",
          );
          const loserUpdate = database
            .prepare(
              `UPDATE runtime_recovery_candidates
               SET action_status = 'not_applied', claim_id = ?, result_json = ?, action_completed_at = ?, updated_at = ?
               WHERE recovery_run_id = ? AND candidate_key = ? AND action_status = 'pending'`,
            )
            .run(existing.claim_id, resultJson, claimedAt, claimedAt, recoveryRunId, candidateKey);
          if (loserUpdate.changes !== 1) {
            throw new CrashRecoveryLedgerConflictError(`Recovery candidate ${candidateKey} lost its audit update race`);
          }
        }
        return { status: "existing", claim: rowToRecoveryClaim(existing) };
      }
      if (candidate.action_status !== "pending" || candidate.claim_id !== null) {
        throw new CrashRecoveryLedgerConflictError(
          `Recovery candidate ${candidateKey} is not pending an unclaimed apply action`,
        );
      }

      if (candidate.candidate_type === "turn_attempt") {
        const attempt = candidate.attempt_id ? getTurnAttemptRow(database, candidate.attempt_id) : null;
        if (!attempt) throw new CrashRecoveryLedgerNotFoundError(`Candidate attempt is missing for ${candidateKey}`);
        rowToTurnAttempt(attempt);
        if (attempt.status !== "running" || attempt.recovery_claim_id !== null) {
          throw new CrashRecoveryLedgerConflictError(`Candidate attempt ${attempt.attempt_id} is no longer claimable`);
        }
      } else {
        const queueItem = candidate.queue_item_id ? getPromptQueueRow(database, candidate.queue_item_id) : null;
        if (!queueItem)
          throw new CrashRecoveryLedgerNotFoundError(`Candidate queue item is missing for ${candidateKey}`);
        rowToPromptQueue(queueItem);
        if (TERMINAL_QUEUE_STATUSES.has(queueItem.status) || queueItem.recovery_claim_id !== null) {
          throw new CrashRecoveryLedgerConflictError(
            `Candidate queue item ${queueItem.queue_item_id} is no longer claimable`,
          );
        }
      }

      database
        .prepare(
          `INSERT INTO runtime_recovery_claims (
             candidate_key, claim_id, candidate_type, session_key, attempt_id, queue_item_id,
             recovery_run_id, claimed_by_boot_epoch, status, claimed_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?, ?, ?)`,
        )
        .run(
          candidateKey,
          requestedClaimId,
          candidate.candidate_type,
          candidate.session_key,
          candidate.attempt_id,
          candidate.queue_item_id,
          recoveryRunId,
          claimedByBootEpoch,
          claimedAt,
          claimedAt,
          claimedAt,
        );

      if (candidate.candidate_type === "turn_attempt") {
        const updated = database
          .prepare(
            `UPDATE runtime_turn_attempts
             SET recovery_claim_id = ?, recovery_status = 'claimed', recovery_reason = ?,
                 recovery_run_id = ?, updated_at = MAX(updated_at, ?)
             WHERE attempt_id = ? AND status = 'running' AND recovery_claim_id IS NULL`,
          )
          .run(requestedClaimId, candidate.reason_code, recoveryRunId, claimedAt, candidate.attempt_id);
        if (updated.changes !== 1) {
          throw new CrashRecoveryLedgerConflictError(`Candidate attempt ${candidate.attempt_id} lost its claim race`);
        }
      } else {
        const updated = database
          .prepare(
            `UPDATE runtime_prompt_queue
             SET recovery_claim_id = ?, recovery_status = 'claimed', recovery_reason = ?,
                 recovery_run_id = ?, updated_at = MAX(updated_at, ?)
             WHERE queue_item_id = ? AND recovery_claim_id IS NULL
               AND status NOT IN ('complete','cancelled','superseded','failed')`,
          )
          .run(requestedClaimId, candidate.reason_code, recoveryRunId, claimedAt, candidate.queue_item_id);
        if (updated.changes !== 1) {
          throw new CrashRecoveryLedgerConflictError(
            `Candidate queue item ${candidate.queue_item_id} lost its claim race`,
          );
        }
      }

      const candidateUpdate = database
        .prepare(
          `UPDATE runtime_recovery_candidates
           SET action_status = 'claimed', claim_id = ?, updated_at = ?
           WHERE recovery_run_id = ? AND candidate_key = ? AND action_status = 'pending' AND claim_id IS NULL`,
        )
        .run(requestedClaimId, claimedAt, recoveryRunId, candidateKey);
      if (candidateUpdate.changes !== 1) {
        throw new CrashRecoveryLedgerConflictError(`Recovery candidate ${candidateKey} lost its claim race`);
      }
      const claim = getRecoveryClaimByCandidateRow(database, candidateKey);
      if (!claim) throw new CrashRecoveryLedgerNotFoundError(`Recovery claim missing after acquire: ${candidateKey}`);
      return { status: "acquired", claim: rowToRecoveryClaim(claim) };
    },
    { label: "runtime-crash-recovery-acquire-claim" },
  );
}

function getRecoveryClaimByIdRow(database: Database, claimId: string): RuntimeRecoveryClaimRow | null {
  return (
    (database.prepare("SELECT * FROM runtime_recovery_claims WHERE claim_id = ?").get(claimId) as
      | RuntimeRecoveryClaimRow
      | undefined) ?? null
  );
}

export function getRuntimeRecoveryClaimByCandidate(candidateKey: string): RuntimeRecoveryClaimRecord | null {
  const row = getRecoveryClaimByCandidateRow(getDb(), requiredText(candidateKey, "candidateKey"));
  return row ? rowToRecoveryClaim(row) : null;
}

export function completeRuntimeRecoveryClaim(input: {
  claimId: string;
  status: Exclude<RuntimeRecoveryClaimStatus, "claimed">;
  result: JsonRecord;
  completedAt?: number;
}): { claim: RuntimeRecoveryClaimRecord; candidate: RuntimeRecoveryCandidateRecord } {
  const claimId = requiredText(input.claimId, "claimId");
  const completedAt = assertTimestamp(input.completedAt ?? Date.now(), "completedAt");
  const resultJson = stringifyRequiredJson(input.result, "claim result");

  return executeWrite(
    getDb(),
    (database) => {
      const current = getRecoveryClaimByIdRow(database, claimId);
      if (!current) throw new CrashRecoveryLedgerNotFoundError(`Recovery claim not found: ${claimId}`);
      rowToRecoveryClaim(current);
      const candidate = getRecoveryCandidateRow(database, current.recovery_run_id, current.candidate_key);
      if (!candidate) {
        throw new CrashRecoveryLedgerNotFoundError(
          `Winning recovery candidate ${current.candidate_key} is missing for claim ${claimId}`,
        );
      }
      rowToRecoveryCandidate(candidate);
      if (current.status === input.status) {
        const sameCompletion = input.completedAt === undefined || completedAt === current.completed_at;
        const sameResult = current.result_json === resultJson;
        const candidateMatches =
          candidate.action_status === input.status &&
          candidate.claim_id === claimId &&
          candidate.action_completed_at === current.completed_at &&
          candidate.result_json === current.result_json;
        const expectedRecoveryStatus = input.status === "applied" ? candidate.decision : "action_failed";
        const source =
          current.candidate_type === "turn_attempt"
            ? current.attempt_id
              ? getTurnAttemptRow(database, current.attempt_id)
              : null
            : current.queue_item_id
              ? getPromptQueueRow(database, current.queue_item_id)
              : null;
        if (source) {
          if (current.candidate_type === "turn_attempt") {
            rowToTurnAttempt(source as RuntimeTurnAttemptRow);
          } else {
            rowToPromptQueue(source as RuntimePromptQueueRow);
          }
        }
        const sourceMatches =
          source?.recovery_claim_id === claimId &&
          source.recovery_status === expectedRecoveryStatus &&
          source.recovery_reason === candidate.reason_code &&
          source.recovery_run_id === current.recovery_run_id &&
          source.recovered_at === current.completed_at;
        if (!sameCompletion || !sameResult || !candidateMatches || !sourceMatches) {
          throw new CrashRecoveryLedgerConflictError(`Recovery claim ${claimId} already has different terminal data`);
        }
        return { claim: rowToRecoveryClaim(current), candidate: rowToRecoveryCandidate(candidate) };
      }
      if (current.status !== "claimed") {
        throw new CrashRecoveryLedgerConflictError(
          `Cannot transition recovery claim ${claimId} from ${current.status} to ${input.status}`,
        );
      }
      if (candidate.action_status !== "claimed" || candidate.claim_id !== claimId) {
        throw new CrashRecoveryLedgerConflictError(`Recovery candidate projection diverged from claim ${claimId}`);
      }
      const run = getRecoveryRunRow(database, current.recovery_run_id);
      if (!run || run.status !== "running" || run.mode !== "apply") {
        throw new CrashRecoveryLedgerConflictError(`Recovery run is no longer open for claim ${claimId}`);
      }
      rowToRecoveryRun(run);
      const boot = getBootEpochRow(database, current.claimed_by_boot_epoch);
      if (!boot || boot.status !== "active" || boot.lease_expires_at <= completedAt) {
        throw new CrashRecoveryLedgerConflictError(`Claiming boot is no longer live for claim ${claimId}`);
      }
      rowToBootEpoch(boot);
      if (completedAt < current.claimed_at || completedAt < current.updated_at || completedAt < candidate.updated_at) {
        throw new CrashRecoveryLedgerConflictError(`Recovery claim ${claimId} completion time is regressive`);
      }

      const claimUpdate = database
        .prepare(
          `UPDATE runtime_recovery_claims
           SET status = ?, completed_at = ?, result_json = ?, updated_at = ?
           WHERE claim_id = ? AND status = 'claimed'`,
        )
        .run(input.status, completedAt, resultJson, completedAt, claimId);
      if (claimUpdate.changes !== 1) {
        throw new CrashRecoveryLedgerConflictError(`Recovery claim ${claimId} lost its terminal transition race`);
      }
      const candidateUpdate = database
        .prepare(
          `UPDATE runtime_recovery_candidates
           SET action_status = ?, result_json = ?, action_completed_at = ?, updated_at = ?
           WHERE recovery_run_id = ? AND candidate_key = ? AND claim_id = ? AND action_status = 'claimed'`,
        )
        .run(
          input.status,
          resultJson,
          completedAt,
          completedAt,
          current.recovery_run_id,
          current.candidate_key,
          claimId,
        );
      if (candidateUpdate.changes !== 1) {
        throw new CrashRecoveryLedgerConflictError(`Recovery candidate projection diverged for claim ${claimId}`);
      }

      const recoveryStatus = input.status === "applied" ? candidate.decision : "action_failed";
      let sourceProjection: RuntimeTurnAttemptRow | RuntimePromptQueueRow | null;
      if (current.candidate_type === "turn_attempt") {
        const source = current.attempt_id ? getTurnAttemptRow(database, current.attempt_id) : null;
        if (!source || completedAt < source.updated_at) {
          throw new CrashRecoveryLedgerConflictError(`Attempt projection is missing or newer than claim ${claimId}`);
        }
        rowToTurnAttempt(source);
        if (
          source.recovery_claim_id !== claimId ||
          source.recovery_status !== "claimed" ||
          source.recovery_reason !== candidate.reason_code ||
          source.recovery_run_id !== current.recovery_run_id ||
          source.recovered_at !== null
        ) {
          throw new CrashRecoveryLedgerConflictError(`Attempt projection diverged for claim ${claimId}`);
        }
        const sourceUpdate = database
          .prepare(
            `UPDATE runtime_turn_attempts
             SET recovery_status = ?, recovery_reason = ?, recovered_at = ?, updated_at = MAX(updated_at, ?)
             WHERE attempt_id = ? AND recovery_claim_id = ? AND recovery_status = 'claimed'
               AND recovery_reason = ? AND recovery_run_id = ? AND recovered_at IS NULL`,
          )
          .run(
            recoveryStatus,
            candidate.reason_code,
            completedAt,
            completedAt,
            current.attempt_id,
            claimId,
            candidate.reason_code,
            current.recovery_run_id,
          );
        if (sourceUpdate.changes !== 1) {
          throw new CrashRecoveryLedgerConflictError(`Attempt projection diverged for claim ${claimId}`);
        }
        sourceProjection = current.attempt_id ? getTurnAttemptRow(database, current.attempt_id) : null;
      } else {
        const source = current.queue_item_id ? getPromptQueueRow(database, current.queue_item_id) : null;
        if (!source || completedAt < source.updated_at) {
          throw new CrashRecoveryLedgerConflictError(`Queue projection is missing or newer than claim ${claimId}`);
        }
        rowToPromptQueue(source);
        if (
          source.recovery_claim_id !== claimId ||
          source.recovery_status !== "claimed" ||
          source.recovery_reason !== candidate.reason_code ||
          source.recovery_run_id !== current.recovery_run_id ||
          source.recovered_at !== null
        ) {
          throw new CrashRecoveryLedgerConflictError(`Queue projection diverged for claim ${claimId}`);
        }
        const sourceUpdate = database
          .prepare(
            `UPDATE runtime_prompt_queue
             SET recovery_status = ?, recovery_reason = ?, recovered_at = ?, updated_at = MAX(updated_at, ?)
             WHERE queue_item_id = ? AND recovery_claim_id = ? AND recovery_status = 'claimed'
               AND recovery_reason = ? AND recovery_run_id = ? AND recovered_at IS NULL`,
          )
          .run(
            recoveryStatus,
            candidate.reason_code,
            completedAt,
            completedAt,
            current.queue_item_id,
            claimId,
            candidate.reason_code,
            current.recovery_run_id,
          );
        if (sourceUpdate.changes !== 1) {
          throw new CrashRecoveryLedgerConflictError(`Queue projection diverged for claim ${claimId}`);
        }
        sourceProjection = current.queue_item_id ? getPromptQueueRow(database, current.queue_item_id) : null;
      }

      const claimRow = getRecoveryClaimByIdRow(database, claimId);
      const candidateRow = getRecoveryCandidateRow(database, current.recovery_run_id, current.candidate_key);
      if (
        !claimRow ||
        !candidateRow ||
        !sourceProjection ||
        sourceProjection.recovery_claim_id !== claimId ||
        sourceProjection.recovery_status !== recoveryStatus ||
        sourceProjection.recovered_at !== completedAt
      ) {
        throw new CrashRecoveryLedgerNotFoundError(`Recovery claim projections missing after completion: ${claimId}`);
      }
      if (current.candidate_type === "turn_attempt") {
        rowToTurnAttempt(sourceProjection as RuntimeTurnAttemptRow);
      } else {
        rowToPromptQueue(sourceProjection as RuntimePromptQueueRow);
      }
      return { claim: rowToRecoveryClaim(claimRow), candidate: rowToRecoveryCandidate(candidateRow) };
    },
    { label: "runtime-crash-recovery-complete-claim" },
  );
}

export interface CrashRecoveryStore {
  createBootEpoch: typeof createRuntimeBootEpoch;
  getBootEpoch: typeof getRuntimeBootEpoch;
  listBootEpochs: typeof listRuntimeBootEpochs;
  heartbeatBootEpoch: typeof heartbeatRuntimeBootEpoch;
  markBootEpochGracefulStopped: typeof markRuntimeBootEpochGracefulStopped;
  markBootEpochAbandoned: typeof markRuntimeBootEpochAbandoned;
  createTurnAttempt: typeof createRuntimeTurnAttempt;
  getTurnAttempt: typeof getRuntimeTurnAttempt;
  listTurnAttempts: typeof listRuntimeTurnAttempts;
  heartbeatTurnAttempt: typeof heartbeatRuntimeTurnAttempt;
  markTurnAttemptSafety: typeof markRuntimeTurnAttemptSafety;
  terminalizeTurnAttempt: typeof terminalizeRuntimeTurnAttempt;
  enqueuePrompt: typeof enqueueRuntimePrompt;
  getPromptQueueItem: typeof getRuntimePromptQueueItem;
  listPromptQueue: typeof listRuntimePromptQueue;
  compareAndSetPromptQueueStatus: typeof compareAndSetRuntimePromptQueueStatus;
  createRecoveryRun: typeof createRuntimeRecoveryRun;
  getRecoveryRun: typeof getRuntimeRecoveryRun;
  listRecoveryRuns: typeof listRuntimeRecoveryRuns;
  completeRecoveryRun: typeof completeRuntimeRecoveryRun;
  buildRecoveryCandidateKey: typeof buildRuntimeRecoveryCandidateKey;
  recordRecoveryCandidate: typeof recordRuntimeRecoveryCandidate;
  getRecoveryCandidate: typeof getRuntimeRecoveryCandidate;
  listRecoveryCandidates: typeof listRuntimeRecoveryCandidates;
  acquireRecoveryClaim: typeof acquireRuntimeRecoveryClaim;
  getRecoveryClaimByCandidate: typeof getRuntimeRecoveryClaimByCandidate;
  completeRecoveryClaim: typeof completeRuntimeRecoveryClaim;
}

export const sqliteCrashRecoveryStore: CrashRecoveryStore = {
  createBootEpoch: createRuntimeBootEpoch,
  getBootEpoch: getRuntimeBootEpoch,
  listBootEpochs: listRuntimeBootEpochs,
  heartbeatBootEpoch: heartbeatRuntimeBootEpoch,
  markBootEpochGracefulStopped: markRuntimeBootEpochGracefulStopped,
  markBootEpochAbandoned: markRuntimeBootEpochAbandoned,
  createTurnAttempt: createRuntimeTurnAttempt,
  getTurnAttempt: getRuntimeTurnAttempt,
  listTurnAttempts: listRuntimeTurnAttempts,
  heartbeatTurnAttempt: heartbeatRuntimeTurnAttempt,
  markTurnAttemptSafety: markRuntimeTurnAttemptSafety,
  terminalizeTurnAttempt: terminalizeRuntimeTurnAttempt,
  enqueuePrompt: enqueueRuntimePrompt,
  getPromptQueueItem: getRuntimePromptQueueItem,
  listPromptQueue: listRuntimePromptQueue,
  compareAndSetPromptQueueStatus: compareAndSetRuntimePromptQueueStatus,
  createRecoveryRun: createRuntimeRecoveryRun,
  getRecoveryRun: getRuntimeRecoveryRun,
  listRecoveryRuns: listRuntimeRecoveryRuns,
  completeRecoveryRun: completeRuntimeRecoveryRun,
  buildRecoveryCandidateKey: buildRuntimeRecoveryCandidateKey,
  recordRecoveryCandidate: recordRuntimeRecoveryCandidate,
  getRecoveryCandidate: getRuntimeRecoveryCandidate,
  listRecoveryCandidates: listRuntimeRecoveryCandidates,
  acquireRecoveryClaim: acquireRuntimeRecoveryClaim,
  getRecoveryClaimByCandidate: getRuntimeRecoveryClaimByCandidate,
  completeRecoveryClaim: completeRuntimeRecoveryClaim,
};
