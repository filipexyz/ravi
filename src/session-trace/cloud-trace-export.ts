import { createHash } from "node:crypto";
import { getDb } from "../router/router-db.js";
import { DEFAULT_RUNTIME_PROVIDER_ID } from "../runtime/provider-registry.js";
import {
  enqueueSyncEvent,
  getSyncCursor,
  listPendingOutboxBatch,
  markOutboxAcked,
  markOutboxFailed,
  setSyncCursor,
} from "../sync/db.js";
import { sanitizeSyncError, sanitizeSyncPayload } from "../sync/redaction.js";
import { createConsoleSyncBridge, type ConsoleSyncBridge } from "../sync/console-bridge.js";

const TRACE_CURSOR_DOMAIN = "runtime_trace";
const SESSION_EVENTS_CURSOR = "session_events_enqueued";
const DEFAULT_LIMIT = 250;
const DEFAULT_MAX_EVENTS_PER_PAYLOAD = 200;
const PREVIEW_CHARS = 500;

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
  canonical_chat_id: string | null;
  actor_type: string | null;
  contact_id: string | null;
  actor_agent_id: string | null;
  platform_identity_id: string | null;
  message_id: string | null;
  provider: string | null;
  model: string | null;
  payload_json: string | null;
  preview: string | null;
  error: string | null;
  duration_ms: number | null;
  created_at: number;
}

interface SessionTurnRow {
  turn_id: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  cost_usd: number | null;
  status: string;
  session_key: string;
  session_name: string | null;
  run_id: string | null;
  agent_id: string | null;
  provider: string | null;
  model: string | null;
  user_prompt_sha256: string | null;
  system_prompt_sha256: string | null;
  request_blob_sha256: string | null;
  started_at: number;
  completed_at: number | null;
}

export interface CloudTraceExportEvent {
  eventId: string;
  localEventId: number;
  sessionKey: string;
  sessionName: string | null;
  agentId: string | null;
  runId: string | null;
  turnId: string | null;
  sequence: number;
  eventType: string;
  eventGroup: string;
  status: string | null;
  provider: string | null;
  model: string | null;
  source: {
    channel: string | null;
    accountId: string | null;
    chatId: string | null;
    threadId: string | null;
    canonicalChatId: string | null;
  };
  actor: {
    type: string | null;
    contactId: string | null;
    agentId: string | null;
    platformIdentityId: string | null;
  };
  messageId: string | null;
  safePreview: string | null;
  safePayload: unknown;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costUsd: number;
  };
  durationMs: number | null;
  occurredAt: string;
  schemaVersion: 1;
}

export interface EnqueueTraceExportBatchInput {
  limit?: number;
  now?: number;
}

export interface EnqueueTraceExportBatchResult {
  enqueued: boolean;
  sourceEvents: number;
  exportedEvents: number;
  firstEventId: number | null;
  lastEventId: number | null;
  outboxId: string | null;
}

export interface PushTraceExportBatchResult {
  linked: boolean;
  status: "unlinked" | "noop" | "uploaded" | "failed";
  attempted: number;
  acked: number;
  failed: number;
  errorCode?: string;
}

export function enqueueTraceExportBatch(input: EnqueueTraceExportBatchInput = {}): EnqueueTraceExportBatchResult {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), DEFAULT_MAX_EVENTS_PER_PAYLOAD);
  const now = input.now ?? Date.now();
  const cursor = Number(getSyncCursor(TRACE_CURSOR_DOMAIN, SESSION_EVENTS_CURSOR)?.cursorValue ?? 0);
  const rows = loadNextTraceRows(Number.isFinite(cursor) ? cursor : 0, limit);

  if (rows.length === 0) {
    return {
      enqueued: false,
      sourceEvents: 0,
      exportedEvents: 0,
      firstEventId: null,
      lastEventId: null,
      outboxId: null,
    };
  }

  const turnIds = [...new Set(rows.map((row) => row.turn_id).filter((value): value is string => !!value))];
  const turns = loadTurns(turnIds);
  const events = coalesceTraceEvents(rows).map((row) => toExportEvent(row, turns.get(row.turn_id ?? "")));
  const payload = buildRuntimeTracePayload(rows, turns, events);
  const first = rows[0]!.id;
  const last = rows[rows.length - 1]!.id;
  const outbox = enqueueSyncEvent({
    eventId: deterministicTraceBatchId(first, last, events.length),
    domain: TRACE_CURSOR_DOMAIN,
    eventType: "runtime.trace.export",
    entityType: "session_events",
    entityId: `${first}-${last}`,
    idempotencyKey: `runtime-trace:${first}:${last}:${events.length}`,
    payload,
    schemaVersion: 1,
    occurredAt: now,
    now,
  });
  setSyncCursor(
    TRACE_CURSOR_DOMAIN,
    SESSION_EVENTS_CURSOR,
    String(last),
    {
      firstEventId: first,
      lastEventId: last,
      exportedEvents: events.length,
    },
    now,
  );

  return {
    enqueued: !!outbox,
    sourceEvents: rows.length,
    exportedEvents: events.length,
    firstEventId: first,
    lastEventId: last,
    outboxId: outbox?.id ?? null,
  };
}

export async function pushTraceExportBatch(
  input: { bridge?: ConsoleSyncBridge; limit?: number; maxBytes?: number; now?: number } = {},
): Promise<PushTraceExportBatchResult> {
  const bridge = input.bridge ?? createConsoleSyncBridge();
  if (!bridge.isLinked()) return { linked: false, status: "unlinked", attempted: 0, acked: 0, failed: 0 };

  const batch = listPendingOutboxBatch({
    domain: TRACE_CURSOR_DOMAIN,
    limit: input.limit ?? 1,
    maxBytes: input.maxBytes,
    now: input.now,
  });
  if (batch.items.length === 0) return { linked: true, status: "noop", attempted: 0, acked: 0, failed: 0 };

  let attempted = 0;
  let acked = 0;
  let failed = 0;
  let firstErrorCode: string | undefined;

  for (const item of batch.items) {
    attempted += 1;
    try {
      await bridge.uploadRuntimeTraceEvents(item.payload);
      markOutboxAcked([item.id]);
      acked += 1;
    } catch (error) {
      const code = traceExportErrorCode(error);
      const retryable = isRetryableTraceExportError(error);
      firstErrorCode ??= code;
      failed += 1;
      markOutboxFailed({
        ids: [item.id],
        errorCode: code,
        retryable,
      });
      if (retryable) break;
    }
  }

  if (failed > 0) {
    return { linked: true, status: "failed", attempted, acked, failed, errorCode: firstErrorCode };
  }
  return { linked: true, status: "uploaded", attempted, acked, failed };
}

export function getTraceExportCursor(): number | null {
  const raw = getSyncCursor(TRACE_CURSOR_DOMAIN, SESSION_EVENTS_CURSOR)?.cursorValue;
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function loadTurns(turnIds: string[]): Map<string, SessionTurnRow> {
  if (turnIds.length === 0) return new Map();
  const rows = getDb()
    .prepare(`SELECT * FROM session_turns WHERE turn_id IN (${turnIds.map(() => "?").join(",")})`)
    .all(...turnIds) as SessionTurnRow[];
  return new Map(rows.map((row) => [row.turn_id, row]));
}

function loadNextTraceRows(cursor: number, limit: number): SessionEventRow[] {
  const first = getDb().prepare("SELECT * FROM session_events WHERE id > ? ORDER BY id ASC LIMIT 1").get(cursor) as
    | SessionEventRow
    | undefined;
  if (!first) return [];

  const candidates = getDb()
    .prepare(
      `
      SELECT * FROM session_events
      WHERE id > ?
      ORDER BY id ASC
      LIMIT ?
    `,
    )
    .all(cursor, limit) as SessionEventRow[];

  const rows: SessionEventRow[] = [];
  for (const row of candidates) {
    if (row.session_key !== first.session_key) break;
    rows.push(row);
  }
  return rows;
}

function coalesceTraceEvents(rows: SessionEventRow[]): SessionEventRow[] {
  const output: SessionEventRow[] = [];
  let pendingDelta: SessionEventRow | null = null;
  let pendingText = "";

  const flush = () => {
    if (!pendingDelta) return;
    output.push({
      ...pendingDelta,
      event_type: "message.assistant",
      event_group: "response",
      preview: pendingText,
      payload_json: JSON.stringify({ coalesced: true, delta_count: pendingText ? undefined : 0 }),
    });
    pendingDelta = null;
    pendingText = "";
  };

  for (const row of rows) {
    if (row.event_type === "assistant.delta") {
      pendingDelta ??= row;
      pendingText += row.preview ?? previewFromPayload(row.payload_json) ?? "";
      continue;
    }
    flush();
    if (shouldExportEvent(row.event_type)) output.push(row);
  }
  flush();
  return output;
}

function shouldExportEvent(eventType: string): boolean {
  return (
    eventType === "adapter.request" ||
    eventType === "message.user" ||
    eventType === "message.assistant" ||
    eventType === "assistant.message" ||
    eventType === "tool.start" ||
    eventType === "tool.end" ||
    eventType === "tool.started" ||
    eventType === "tool.completed" ||
    eventType === "turn.complete" ||
    eventType === "turn.failed" ||
    eventType === "turn.interrupted" ||
    eventType.startsWith("approval.")
  );
}

function toExportEvent(row: SessionEventRow, turn?: SessionTurnRow): CloudTraceExportEvent {
  return {
    eventId: `session_event:${row.id}`,
    localEventId: row.id,
    sessionKey: row.session_key,
    sessionName: row.session_name,
    agentId: row.agent_id,
    runId: row.run_id,
    turnId: row.turn_id,
    sequence: row.seq,
    eventType: mapEventType(row.event_type),
    eventGroup: mapEventGroup(row.event_group, row.event_type),
    status: row.status,
    provider: row.provider,
    model: row.model,
    source: {
      channel: row.source_channel,
      accountId: row.source_account_id,
      chatId: row.source_chat_id,
      threadId: row.source_thread_id,
      canonicalChatId: row.canonical_chat_id,
    },
    actor: {
      type: row.actor_type,
      contactId: row.contact_id,
      agentId: row.actor_agent_id,
      platformIdentityId: row.platform_identity_id,
    },
    messageId: row.message_id,
    safePreview: safePreview(row.preview ?? row.error),
    safePayload: safeTracePayload(row),
    ...(isTerminalEvent(row.event_type) && turn ? { usage: usageFromTurn(turn) } : {}),
    durationMs: row.duration_ms,
    occurredAt: new Date(row.timestamp).toISOString(),
    schemaVersion: 1,
  };
}

function buildRuntimeTracePayload(
  rows: SessionEventRow[],
  turns: Map<string, SessionTurnRow>,
  events: CloudTraceExportEvent[],
) {
  const first = rows[0]!;
  const orderedTurns = orderTurnsForRows(rows, turns);
  const runtimeProvider = resolveRuntimeProvider(orderedTurns, events, rows);
  const turnList = orderedTurns.map((turn, index) => ({
    turnId: turn.turn_id,
    sourceTurnId: turn.turn_id,
    sequence: index + 1,
    sessionKey: turn.session_key,
    sessionName: turn.session_name,
    runId: turn.run_id,
    agentId: turn.agent_id,
    provider: turn.provider,
    model: turn.model,
    status: turn.status,
    userPromptSha256: turn.user_prompt_sha256,
    systemPromptSha256: turn.system_prompt_sha256,
    requestBlobSha256: turn.request_blob_sha256,
    usage: usageFromTurn(turn),
    startedAt: new Date(turn.started_at).toISOString(),
    completedAt: turn.completed_at ? new Date(turn.completed_at).toISOString() : null,
    schemaVersion: 1,
  }));
  return sanitizeSyncPayload({
    session: {
      sessionKey: first.session_key,
      sessionName: first.session_name,
      agentId: first.agent_id,
      runId: first.run_id,
      runtimeProvider,
      provider: runtimeProvider,
      source: {
        channel: first.source_channel,
        accountId: first.source_account_id,
        chatId: first.source_chat_id,
        threadId: first.source_thread_id,
        canonicalChatId: first.canonical_chat_id,
      },
      firstEventId: rows[0]!.id,
      lastEventId: rows[rows.length - 1]!.id,
      schemaVersion: 1,
    },
    turns: turnList,
    events,
    toolCalls: buildToolCalls(events),
    // Console trace blobs require a remote r2Key/blobRef. OSS does not upload
    // blobs to remote storage yet, so keep hashes on turns/events and omit
    // metadata-only blob rows that the Console ingest contract rejects.
    blobs: [],
  });
}

function orderTurnsForRows(rows: SessionEventRow[], turns: Map<string, SessionTurnRow>): SessionTurnRow[] {
  const ids = [...new Set(rows.map((row) => row.turn_id).filter((value): value is string => !!value))];
  return ids
    .map((id) => turns.get(id))
    .filter((turn): turn is SessionTurnRow => !!turn)
    .sort((a, b) => a.started_at - b.started_at || a.turn_id.localeCompare(b.turn_id));
}

function resolveRuntimeProvider(
  turns: SessionTurnRow[],
  events: CloudTraceExportEvent[],
  rows: SessionEventRow[],
): string {
  return (
    firstNonEmptyString(turns.map((turn) => turn.provider)) ??
    firstNonEmptyString(events.map((event) => event.provider)) ??
    firstNonEmptyString(rows.map((row) => row.provider)) ??
    DEFAULT_RUNTIME_PROVIDER_ID
  );
}

function firstNonEmptyString(values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function buildToolCalls(events: CloudTraceExportEvent[]) {
  const calls = new Map<string, Record<string, unknown>>();
  for (const event of events) {
    if (event.eventType !== "tool.started" && event.eventType !== "tool.completed") continue;
    const payload = event.safePayload as Record<string, unknown>;
    const id = stringValue(payload.toolId) ?? stringValue(payload.toolCallId) ?? event.eventId;
    const current = calls.get(id) ?? {
      id,
      sessionKey: event.sessionKey,
      turnId: event.turnId,
      toolName: stringValue(payload.toolName) ?? "tool",
      status: "started",
      startedAt: null,
      completedAt: null,
      durationMs: null,
      isError: false,
      safePreview: event.safePreview,
      safePayload: payload,
      schemaVersion: 1,
    };
    if (event.eventType === "tool.started") {
      current.startedAt = event.occurredAt;
    } else {
      current.status = payload.isError ? "failed" : "completed";
      current.completedAt = event.occurredAt;
      current.durationMs = event.durationMs;
      current.isError = Boolean(payload.isError);
    }
    calls.set(id, current);
  }
  return [...calls.values()];
}

function safeTracePayload(row: SessionEventRow): unknown {
  const payload = parseJson(row.payload_json);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const source = payload as Record<string, unknown>;
  if (row.event_type === "adapter.request") {
    return sanitizeSyncPayload({
      requestBlobSha256: source.request_blob_sha256,
      userPromptSha256: source.user_prompt_sha256,
      systemPromptSha256: source.system_prompt_sha256,
      systemPromptChars: source.system_prompt_chars,
      userPromptChars: source.user_prompt_chars,
      provider: source.provider,
      model: source.model,
      resume: source.resume,
      fork: source.fork,
      deliveryBarrier: source.delivery_barrier,
      capabilitySummary: source.capability_summary,
      queuedMessageCount: source.queued_message_count,
    });
  }
  if (row.event_group === "tool") {
    return sanitizeSyncPayload({
      toolId: source.toolId ?? source.toolCallId ?? source.tool_call_id ?? source.toolUseId,
      toolCallId: source.toolCallId ?? source.tool_call_id,
      toolName: source.toolName ?? source.tool_name ?? source.name,
      isError: source.isError,
      safety: source.safety,
      durationMs: row.duration_ms,
    });
  }
  return sanitizeSyncPayload(source);
}

function usageFromTurn(turn: SessionTurnRow) {
  return {
    inputTokens: turn.input_tokens ?? 0,
    outputTokens: turn.output_tokens ?? 0,
    cacheReadTokens: turn.cache_read_tokens ?? 0,
    cacheCreationTokens: turn.cache_creation_tokens ?? 0,
    costUsd: turn.cost_usd ?? 0,
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function traceExportErrorCode(error: unknown): string {
  const message = sanitizeSyncError(error);
  return (
    message
      .toUpperCase()
      .replace(/[^A-Z0-9_]/g, "_")
      .replace(/_+/g, "_")
      .slice(0, 80) || "TRACE_EXPORT_FAILED"
  );
}

function isRetryableTraceExportError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return true;
  const code = String((error as { code?: unknown }).code);
  return code === "RATE_LIMITED" || code === "SERVER_UNAVAILABLE" || code === "AUTH_PENDING";
}

function mapEventType(eventType: string): string {
  if (eventType === "assistant.message") return "message.assistant";
  if (eventType === "tool.start") return "tool.started";
  if (eventType === "tool.end") return "tool.completed";
  if (eventType === "approval.request") return "approval.requested";
  if (eventType === "approval.response") return "approval.completed";
  return eventType;
}

function mapEventGroup(eventGroup: string, eventType: string): string {
  if (eventType === "adapter.request") return "adapter";
  if (eventType === "assistant.message" || eventType === "assistant.delta") return "response";
  return eventGroup;
}

function isTerminalEvent(eventType: string): boolean {
  return eventType === "turn.complete" || eventType === "turn.failed" || eventType === "turn.interrupted";
}

function safePreview(value: string | null): string | null {
  if (!value) return null;
  const clean = sanitizeSyncPayload({ preview: value }) as { preview: string };
  return clean.preview.length > PREVIEW_CHARS ? `${clean.preview.slice(0, PREVIEW_CHARS)}...` : clean.preview;
}

function previewFromPayload(payloadJson: string | null): string | null {
  const payload = parseJson(payloadJson);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const text = (payload as Record<string, unknown>).text ?? (payload as Record<string, unknown>).delta;
  return typeof text === "string" ? text : null;
}

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function deterministicTraceBatchId(first: number, last: number, count: number): string {
  return `trace_batch_${createHash("sha256").update(`${first}:${last}:${count}`).digest("hex").slice(0, 24)}`;
}
