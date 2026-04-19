import { createHash } from "node:crypto";
import { getDb } from "../router/router-db.js";
import type {
  JsonValue,
  RecordSessionBlobInput,
  RecordSessionEventInput,
  RedactionResult,
  SessionEventRecord,
  SessionTraceBlobRecord,
  SessionTurnRecord,
  UpsertSessionTurnInput,
} from "./types.js";

const REDACTED = "[REDACTED]";

const SECRET_KEY_PATTERN =
  /(^|[_\-.\s])(api[_\-.\s]*key|token|secret|password|passwd|pwd|credential|credentials|cookie|authorization|auth|bearer|private[_\-.\s]*key|access[_\-.\s]*token|refresh[_\-.\s]*token|client[_\-.\s]*secret|context[_\-.\s]*key)([_\-.\s]|$)/i;

const SECRET_ASSIGNMENT_PATTERN =
  /\b([A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL|CREDENTIALS|COOKIE|AUTHORIZATION|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET|CONTEXT_KEY)[A-Z0-9_]*)=([^\s"']+)/g;

interface SessionEventRow {
  id: number;
  session_key: string;
  session_name: string | null;
  agent_id: string | null;
  run_id: string | null;
  turn_id: string | null;
  seq: number;
  event_type: string;
  event_group: string;
  status: string | null;
  timestamp: number;
  source_channel: string | null;
  source_account_id: string | null;
  source_chat_id: string | null;
  source_thread_id: string | null;
  message_id: string | null;
  provider: string | null;
  model: string | null;
  payload_json: string | null;
  preview: string | null;
  error: string | null;
  duration_ms: number | null;
  created_at: number;
}

interface SessionTraceBlobRow {
  sha256: string;
  kind: string;
  size_bytes: number;
  content_text: string | null;
  content_json: string | null;
  redacted: number;
  created_at: number;
}

interface SessionTurnRow {
  turn_id: string;
  session_key: string;
  session_name: string | null;
  run_id: string | null;
  agent_id: string | null;
  provider: string | null;
  model: string | null;
  effort: string | null;
  thinking: string | null;
  cwd: string | null;
  status: string;
  resume: number;
  fork: number;
  provider_session_id_before: string | null;
  provider_session_id_after: string | null;
  user_prompt_sha256: string | null;
  system_prompt_sha256: string | null;
  request_blob_sha256: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  cost_usd: number | null;
  error: string | null;
  abort_reason: string | null;
  started_at: number;
  completed_at: number | null;
  updated_at: number;
}

type StoredTurn = {
  turnId: string;
  sessionKey: string;
  sessionName: string | null;
  runId: string | null;
  agentId: string | null;
  provider: string | null;
  model: string | null;
  effort: string | null;
  thinking: string | null;
  cwd: string | null;
  status: string;
  resume: boolean;
  fork: boolean;
  providerSessionIdBefore: string | null;
  providerSessionIdAfter: string | null;
  userPromptSha256: string | null;
  systemPromptSha256: string | null;
  requestBlobSha256: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  error: string | null;
  abortReason: string | null;
  startedAt: number;
  completedAt: number | null;
  updatedAt: number;
};

function requireText(value: string | undefined | null, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${name} is required`);
  }
  return trimmed;
}

function nullableText(value: string | undefined | null): string | null {
  return value ?? null;
}

function hasOwn<T extends object, K extends PropertyKey>(value: T, key: K): value is T & Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

export function redactText(value: string): RedactionResult<string> {
  let redacted = false;
  let next = value.replace(SECRET_ASSIGNMENT_PATTERN, (_match, key: string) => {
    redacted = true;
    return `${key}=${REDACTED}`;
  });

  next = next.replace(/\b(authorization\s*[:=]\s*)bearer\s+[^\s,;]+/gi, (_match, prefix: string) => {
    redacted = true;
    return `${prefix}Bearer ${REDACTED}`;
  });

  next = next.replace(/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, () => {
    redacted = true;
    return `Bearer ${REDACTED}`;
  });

  next = next.replace(
    /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret|token|authorization|cookie|context[_-]?key)["']?\s*[:=]\s*["'])([^"'\s,;}]+)/gi,
    (_match, prefix: string) => {
      redacted = true;
      return `${prefix}${REDACTED}`;
    },
  );

  return { value: next, redacted };
}

function toJsonValue(value: unknown, seen = new WeakSet<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const mapped = value.map((item) =>
      item === undefined || typeof item === "function" || typeof item === "symbol" ? null : toJsonValue(item, seen),
    );
    seen.delete(value);
    return mapped;
  }
  if (isRecord(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const record: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item === undefined || typeof item === "function" || typeof item === "symbol") {
        continue;
      }
      record[key] = toJsonValue(item, seen);
    }
    seen.delete(value);
    return record;
  }
  return String(value);
}

function redactJsonValue(value: JsonValue, keyHint?: string): RedactionResult<JsonValue> {
  if (keyHint && isSecretKey(keyHint)) {
    return { value: REDACTED, redacted: true };
  }

  if (typeof value === "string") {
    return redactText(value);
  }

  if (Array.isArray(value)) {
    let redacted = false;
    const mapped = value.map((item) => {
      const result = redactJsonValue(item, keyHint);
      redacted ||= result.redacted;
      return result.value;
    });
    return { value: mapped, redacted };
  }

  if (value !== null && typeof value === "object") {
    let redacted = false;
    const record: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const result = redactJsonValue(value[key], key);
      redacted ||= result.redacted;
      record[key] = result.value;
    }
    return { value: record, redacted };
  }

  return { value, redacted: false };
}

export function redactJson(value: unknown): RedactionResult<JsonValue> {
  return redactJsonValue(toJsonValue(value));
}

export function stableStringifyJson(value: unknown): string {
  return JSON.stringify(toJsonValue(value));
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function sha256Json(value: unknown): string {
  return sha256Text(stableStringifyJson(value));
}

function parseJsonValue(raw: string | null): JsonValue | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    return null;
  }
}

function nextEventSeq(input: RecordSessionEventInput): number {
  const db = getDb();
  if (input.runId) {
    const row = db
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM session_events WHERE run_id = ?")
      .get(input.runId) as { seq: number };
    return row.seq;
  }
  if (input.turnId) {
    const row = db
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM session_events WHERE turn_id = ?")
      .get(input.turnId) as { seq: number };
    return row.seq;
  }

  const row = db
    .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM session_events WHERE session_key = ?")
    .get(input.sessionKey) as { seq: number };
  return row.seq;
}

function rowToSessionEvent(row: SessionEventRow): SessionEventRecord {
  return {
    id: row.id,
    sessionKey: row.session_key,
    sessionName: row.session_name,
    agentId: row.agent_id,
    runId: row.run_id,
    turnId: row.turn_id,
    seq: row.seq,
    eventType: row.event_type,
    eventGroup: row.event_group,
    status: row.status,
    timestamp: row.timestamp,
    sourceChannel: row.source_channel,
    sourceAccountId: row.source_account_id,
    sourceChatId: row.source_chat_id,
    sourceThreadId: row.source_thread_id,
    messageId: row.message_id,
    provider: row.provider,
    model: row.model,
    payloadJson: parseJsonValue(row.payload_json),
    preview: row.preview,
    error: row.error,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
  };
}

function rowToSessionTraceBlob(row: SessionTraceBlobRow): SessionTraceBlobRecord {
  return {
    sha256: row.sha256,
    kind: row.kind,
    sizeBytes: row.size_bytes,
    contentText: row.content_text,
    contentJson: parseJsonValue(row.content_json),
    redacted: row.redacted === 1,
    createdAt: row.created_at,
  };
}

function rowToSessionTurn(row: SessionTurnRow): SessionTurnRecord {
  return {
    turnId: row.turn_id,
    sessionKey: row.session_key,
    sessionName: row.session_name,
    runId: row.run_id,
    agentId: row.agent_id,
    provider: row.provider,
    model: row.model,
    effort: row.effort,
    thinking: row.thinking,
    cwd: row.cwd,
    status: row.status,
    resume: row.resume === 1,
    fork: row.fork === 1,
    providerSessionIdBefore: row.provider_session_id_before,
    providerSessionIdAfter: row.provider_session_id_after,
    userPromptSha256: row.user_prompt_sha256,
    systemPromptSha256: row.system_prompt_sha256,
    requestBlobSha256: row.request_blob_sha256,
    inputTokens: row.input_tokens ?? 0,
    outputTokens: row.output_tokens ?? 0,
    cacheReadTokens: row.cache_read_tokens ?? 0,
    cacheCreationTokens: row.cache_creation_tokens ?? 0,
    costUsd: row.cost_usd ?? 0,
    error: row.error,
    abortReason: row.abort_reason,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

export function recordSessionEvent(input: RecordSessionEventInput): SessionEventRecord {
  const db = getDb();
  const now = Date.now();
  const payload = hasOwn(input, "payloadJson") ? redactJson(input.payloadJson) : null;
  const preview = input.preview === undefined || input.preview === null ? null : redactText(input.preview).value;
  const error = input.error === undefined || input.error === null ? null : redactText(input.error).value;
  const seq = input.seq ?? nextEventSeq(input);
  const timestamp = input.timestamp ?? now;
  const createdAt = input.createdAt ?? now;

  const result = db
    .prepare(
      `
      INSERT INTO session_events (
        session_key, session_name, agent_id, run_id, turn_id, seq, event_type, event_group,
        status, timestamp, source_channel, source_account_id, source_chat_id, source_thread_id,
        message_id, provider, model, payload_json, preview, error, duration_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      requireText(input.sessionKey, "sessionKey"),
      nullableText(input.sessionName),
      nullableText(input.agentId),
      nullableText(input.runId),
      nullableText(input.turnId),
      seq,
      requireText(input.eventType, "eventType"),
      requireText(input.eventGroup, "eventGroup"),
      nullableText(input.status),
      timestamp,
      nullableText(input.sourceChannel),
      nullableText(input.sourceAccountId),
      nullableText(input.sourceChatId),
      nullableText(input.sourceThreadId),
      nullableText(input.messageId),
      nullableText(input.provider),
      nullableText(input.model),
      payload ? stableStringifyJson(payload.value) : null,
      preview,
      error,
      input.durationMs ?? null,
      createdAt,
    );

  const row = db.prepare("SELECT * FROM session_events WHERE id = ?").get(result.lastInsertRowid) as SessionEventRow;
  return rowToSessionEvent(row);
}

export function recordSessionBlob(input: RecordSessionBlobInput): SessionTraceBlobRecord {
  const db = getDb();
  const hasText = hasOwn(input, "contentText") && input.contentText !== undefined;
  const hasJson = hasOwn(input, "contentJson") && input.contentJson !== undefined;
  if (hasText === hasJson) {
    throw new Error("recordSessionBlob requires exactly one of contentText or contentJson");
  }

  const kind = requireText(input.kind, "kind");
  const createdAt = input.createdAt ?? Date.now();
  let contentText: string | null = null;
  let contentJson: string | null = null;
  let redacted = false;
  let storedContent: string;

  if (hasText) {
    const result = redactText(input.contentText);
    contentText = result.value;
    redacted = result.redacted;
    storedContent = contentText;
  } else {
    const result = redactJson(input.contentJson);
    contentJson = stableStringifyJson(result.value);
    redacted = result.redacted;
    storedContent = contentJson;
  }

  const sha256 = sha256Text(storedContent);
  db.prepare(
    `
    INSERT OR IGNORE INTO session_trace_blobs (
      sha256, kind, size_bytes, content_text, content_json, redacted, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(sha256, kind, Buffer.byteLength(storedContent, "utf8"), contentText, contentJson, redacted ? 1 : 0, createdAt);

  return getSessionTraceBlob(sha256)!;
}

function getExistingTurn(turnId: string): StoredTurn | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM session_turns WHERE turn_id = ?").get(turnId) as SessionTurnRow | undefined;
  return row ? rowToSessionTurn(row) : null;
}

function pickText<K extends keyof UpsertSessionTurnInput>(
  input: UpsertSessionTurnInput,
  key: K,
  current: string | null,
): string | null {
  if (!hasOwn(input, key) || input[key] === undefined) return current;
  return (input[key] as string | null) ?? null;
}

function pickNumber<K extends keyof UpsertSessionTurnInput>(
  input: UpsertSessionTurnInput,
  key: K,
  current: number,
): number {
  if (!hasOwn(input, key) || input[key] === undefined) return current;
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) ? value : current;
}

function pickBoolean<K extends keyof UpsertSessionTurnInput>(
  input: UpsertSessionTurnInput,
  key: K,
  current: boolean,
): boolean {
  if (!hasOwn(input, key) || input[key] === undefined) return current;
  return Boolean(input[key]);
}

function normalizeTurn(input: UpsertSessionTurnInput, current: StoredTurn | null): StoredTurn {
  const now = input.updatedAt ?? Date.now();
  const error =
    hasOwn(input, "error") && input.error !== undefined
      ? input.error === null
        ? null
        : redactText(input.error).value
      : (current?.error ?? null);
  const abortReason =
    hasOwn(input, "abortReason") && input.abortReason !== undefined
      ? input.abortReason === null
        ? null
        : redactText(input.abortReason).value
      : (current?.abortReason ?? null);

  return {
    turnId: requireText(input.turnId, "turnId"),
    sessionKey: requireText(input.sessionKey, "sessionKey"),
    sessionName: pickText(input, "sessionName", current?.sessionName ?? null),
    runId: pickText(input, "runId", current?.runId ?? null),
    agentId: pickText(input, "agentId", current?.agentId ?? null),
    provider: pickText(input, "provider", current?.provider ?? null),
    model: pickText(input, "model", current?.model ?? null),
    effort: pickText(input, "effort", current?.effort ?? null),
    thinking: pickText(input, "thinking", current?.thinking ?? null),
    cwd: pickText(input, "cwd", current?.cwd ?? null),
    status: requireText(input.status, "status"),
    resume: pickBoolean(input, "resume", current?.resume ?? false),
    fork: pickBoolean(input, "fork", current?.fork ?? false),
    providerSessionIdBefore: pickText(input, "providerSessionIdBefore", current?.providerSessionIdBefore ?? null),
    providerSessionIdAfter: pickText(input, "providerSessionIdAfter", current?.providerSessionIdAfter ?? null),
    userPromptSha256: pickText(input, "userPromptSha256", current?.userPromptSha256 ?? null),
    systemPromptSha256: pickText(input, "systemPromptSha256", current?.systemPromptSha256 ?? null),
    requestBlobSha256: pickText(input, "requestBlobSha256", current?.requestBlobSha256 ?? null),
    inputTokens: pickNumber(input, "inputTokens", current?.inputTokens ?? 0),
    outputTokens: pickNumber(input, "outputTokens", current?.outputTokens ?? 0),
    cacheReadTokens: pickNumber(input, "cacheReadTokens", current?.cacheReadTokens ?? 0),
    cacheCreationTokens: pickNumber(input, "cacheCreationTokens", current?.cacheCreationTokens ?? 0),
    costUsd: pickNumber(input, "costUsd", current?.costUsd ?? 0),
    error,
    abortReason,
    startedAt:
      hasOwn(input, "startedAt") && input.startedAt !== undefined
        ? input.startedAt
        : (current?.startedAt ?? input.updatedAt ?? now),
    completedAt:
      hasOwn(input, "completedAt") && input.completedAt !== undefined
        ? (input.completedAt ?? null)
        : (current?.completedAt ?? null),
    updatedAt: now,
  };
}

export function upsertSessionTurn(input: UpsertSessionTurnInput): SessionTurnRecord {
  const db = getDb();
  const turn = normalizeTurn(input, getExistingTurn(input.turnId));

  db.prepare(
    `
    INSERT INTO session_turns (
      turn_id, session_key, session_name, run_id, agent_id, provider, model, effort, thinking,
      cwd, status, resume, fork, provider_session_id_before, provider_session_id_after,
      user_prompt_sha256, system_prompt_sha256, request_blob_sha256, input_tokens, output_tokens,
      cache_read_tokens, cache_creation_tokens, cost_usd, error, abort_reason, started_at,
      completed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(turn_id) DO UPDATE SET
      session_key = excluded.session_key,
      session_name = excluded.session_name,
      run_id = excluded.run_id,
      agent_id = excluded.agent_id,
      provider = excluded.provider,
      model = excluded.model,
      effort = excluded.effort,
      thinking = excluded.thinking,
      cwd = excluded.cwd,
      status = excluded.status,
      resume = excluded.resume,
      fork = excluded.fork,
      provider_session_id_before = excluded.provider_session_id_before,
      provider_session_id_after = excluded.provider_session_id_after,
      user_prompt_sha256 = excluded.user_prompt_sha256,
      system_prompt_sha256 = excluded.system_prompt_sha256,
      request_blob_sha256 = excluded.request_blob_sha256,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_read_tokens = excluded.cache_read_tokens,
      cache_creation_tokens = excluded.cache_creation_tokens,
      cost_usd = excluded.cost_usd,
      error = excluded.error,
      abort_reason = excluded.abort_reason,
      started_at = excluded.started_at,
      completed_at = excluded.completed_at,
      updated_at = excluded.updated_at
  `,
  ).run(
    turn.turnId,
    turn.sessionKey,
    turn.sessionName,
    turn.runId,
    turn.agentId,
    turn.provider,
    turn.model,
    turn.effort,
    turn.thinking,
    turn.cwd,
    turn.status,
    turn.resume ? 1 : 0,
    turn.fork ? 1 : 0,
    turn.providerSessionIdBefore,
    turn.providerSessionIdAfter,
    turn.userPromptSha256,
    turn.systemPromptSha256,
    turn.requestBlobSha256,
    turn.inputTokens,
    turn.outputTokens,
    turn.cacheReadTokens,
    turn.cacheCreationTokens,
    turn.costUsd,
    turn.error,
    turn.abortReason,
    turn.startedAt,
    turn.completedAt,
    turn.updatedAt,
  );

  return getSessionTurn(turn.turnId)!;
}

export function getSessionTraceBlob(sha256: string): SessionTraceBlobRecord | null {
  const row = getDb().prepare("SELECT * FROM session_trace_blobs WHERE sha256 = ?").get(sha256) as
    | SessionTraceBlobRow
    | undefined;
  return row ? rowToSessionTraceBlob(row) : null;
}

export function getSessionTurn(turnId: string): SessionTurnRecord | null {
  const row = getDb().prepare("SELECT * FROM session_turns WHERE turn_id = ?").get(turnId) as
    | SessionTurnRow
    | undefined;
  return row ? rowToSessionTurn(row) : null;
}

export function listSessionEvents(sessionKey: string): SessionEventRecord[] {
  const rows = getDb()
    .prepare("SELECT * FROM session_events WHERE session_key = ? ORDER BY id ASC")
    .all(sessionKey) as SessionEventRow[];
  return rows.map(rowToSessionEvent);
}
