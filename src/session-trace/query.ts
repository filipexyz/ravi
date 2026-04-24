import { getDb } from "../router/router-db.js";
import type { JsonValue, SessionEventRecord, SessionTraceBlobRecord, SessionTurnRecord } from "./types.js";

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
  raw_sender_id: string | null;
  normalized_sender_id: string | null;
  identity_confidence: number | null;
  identity_provenance_json: string | null;
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

interface SessionTraceBlobRow {
  sha256: string;
  kind: string;
  size_bytes: number;
  content_text: string | null;
  content_json: string | null;
  redacted: number;
  created_at: number;
}

type SqlParam = string | number;

export interface SessionTraceOnlyFilter {
  raw: string[];
  groups: string[];
  eventTypes: string[];
  includeTurns: boolean;
}

export interface SessionTraceQueryInput {
  session?: string;
  sessionKey?: string;
  sessionName?: string | null;
  since?: number;
  until?: number;
  limit?: number;
  turnId?: string;
  runId?: string;
  messageId?: string;
  correlationId?: string;
  only?: string | string[];
  includeStream?: boolean;
  includeTurns?: boolean;
  raw?: boolean;
  showSystemPrompt?: boolean;
  showUserPrompt?: boolean;
}

export interface SessionTraceQueryResult {
  session: string | null;
  sessionKey: string | null;
  sessionName: string | null;
  systemPrompt: SessionTraceSystemPromptSnapshot | null;
  filters: {
    since: number | null;
    until: number | null;
    limit: number | null;
    turnId: string | null;
    runId: string | null;
    messageId: string | null;
    correlationId: string | null;
    only: SessionTraceOnlyFilter;
    includeStream: boolean;
    raw: boolean;
    showSystemPrompt: boolean;
    showUserPrompt: boolean;
  };
  events: SessionEventRecord[];
  turns: SessionTurnRecord[];
  blobsBySha256: Record<string, SessionTraceBlobRecord>;
}

export interface SessionTraceSystemPromptSnapshot {
  sha256: string;
  turnId: string | null;
  runId: string | null;
  sessionKey: string;
  sessionName: string | null;
  agentId: string | null;
  provider: string | null;
  model: string | null;
  cwd: string | null;
  recordedAt: number;
  source: "turn" | "adapter.request";
}

const EVENT_GROUP_ALIASES: Record<string, string> = {
  adapters: "adapter",
  adapter: "adapter",
  approvals: "approval",
  approval: "approval",
  channel: "channel",
  channels: "channel",
  delivery: "delivery",
  deliveries: "delivery",
  dispatch: "dispatch",
  prompts: "prompt",
  prompt: "prompt",
  response: "response",
  responses: "response",
  routing: "routing",
  runtime: "runtime",
  session: "session",
  sessions: "session",
  stream: "stream",
  streams: "stream",
  tool: "tool",
  tools: "tool",
};

const TURN_ONLY_ALIASES = new Set(["turn", "turns", "turn.snapshot", "turns.snapshot"]);

function parseJsonValue(raw: string | null): JsonValue | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    return null;
  }
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
    eventGroup: isStreamEventType(row.event_type) ? "stream" : row.event_group,
    status: row.status,
    timestamp: row.timestamp,
    sourceChannel: row.source_channel,
    sourceAccountId: row.source_account_id,
    sourceChatId: row.source_chat_id,
    sourceThreadId: row.source_thread_id,
    canonicalChatId: row.canonical_chat_id,
    actorType: row.actor_type,
    contactId: row.contact_id,
    actorAgentId: row.actor_agent_id,
    platformIdentityId: row.platform_identity_id,
    rawSenderId: row.raw_sender_id,
    normalizedSenderId: row.normalized_sender_id,
    identityConfidence: row.identity_confidence,
    identityProvenance: parseJsonValue(row.identity_provenance_json),
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

function compactText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function splitOnlyValues(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap((item) => item.split(","))
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function normalizeSessionTraceOnly(value: string | string[] | undefined): SessionTraceOnlyFilter {
  const raw = splitOnlyValues(value);
  const groups = new Set<string>();
  const eventTypes = new Set<string>();
  let includeTurns = false;

  for (const item of raw) {
    if (TURN_ONLY_ALIASES.has(item)) {
      includeTurns = true;
      continue;
    }

    const group = EVENT_GROUP_ALIASES[item] ?? (item.endsWith("s") ? EVENT_GROUP_ALIASES[item.slice(0, -1)] : null);
    if (group) {
      groups.add(group);
      continue;
    }

    if (item.includes(".")) {
      eventTypes.add(item);
      continue;
    }

    groups.add(item);
  }

  return {
    raw,
    groups: Array.from(groups).sort(),
    eventTypes: Array.from(eventTypes).sort(),
    includeTurns,
  };
}

function addSessionFilter(
  where: string[],
  params: SqlParam[],
  session?: string,
  sessionKey?: string,
  sessionName?: string | null,
): void {
  const resolvedSessionKey = compactText(sessionKey);
  const resolvedSessionName = compactText(sessionName);
  const rawSession = compactText(session);
  const keyCandidates = Array.from(
    new Set([resolvedSessionKey, rawSession].filter((value): value is string => Boolean(value))),
  );
  const nameCandidates = Array.from(
    new Set([resolvedSessionName, rawSession].filter((value): value is string => Boolean(value))),
  );

  const clauses: string[] = [];
  if (keyCandidates.length > 0) {
    clauses.push(`session_key IN (${keyCandidates.map(() => "?").join(", ")})`);
    params.push(...keyCandidates);
  }
  if (nameCandidates.length > 0) {
    clauses.push(`session_name IN (${nameCandidates.map(() => "?").join(", ")})`);
    params.push(...nameCandidates);
  }
  if (clauses.length > 0) {
    where.push(`(${clauses.join(" OR ")})`);
  }
}

function addTimeFilter(where: string[], params: SqlParam[], column: string, since?: number, until?: number): void {
  if (typeof since === "number" && Number.isFinite(since)) {
    where.push(`${column} >= ?`);
    params.push(since);
  }
  if (typeof until === "number" && Number.isFinite(until)) {
    where.push(`${column} <= ?`);
    params.push(until);
  }
}

function addExactFilter(where: string[], params: SqlParam[], column: string, value: string | undefined): void {
  const text = compactText(value);
  if (!text) return;
  where.push(`${column} = ?`);
  params.push(text);
}

function isRecord(value: JsonValue | null): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function containsCorrelationId(value: JsonValue | null, correlationId: string): boolean {
  if (value === null) return false;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value) === correlationId;
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsCorrelationId(item, correlationId));
  }
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[_-]/g, "");
    if (
      (normalizedKey === "correlationid" || normalizedKey === "correlation" || normalizedKey === "requestid") &&
      String(item) === correlationId
    ) {
      return true;
    }
    if (containsCorrelationId(item, correlationId)) {
      return true;
    }
  }
  return false;
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

function collectRawBlobReferences(value: JsonValue | null, output: Set<string>): void {
  if (value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRawBlobReferences(item, output);
    }
    return;
  }
  if (typeof value !== "object") return;

  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" && isSha256(item) && (key === "request_blob_sha256" || key.endsWith("_blob_sha256"))) {
      output.add(item);
    }
    collectRawBlobReferences(item, output);
  }
}

function isStreamEventType(eventType: string): boolean {
  const type = eventType.toLowerCase();
  if (type === "adapter.raw") return true;
  if (type.includes(".stream")) return true;
  if (type.endsWith(".delta")) return true;
  if (type.includes("provider_event")) return true;
  return false;
}

function isStreamEvent(event: SessionEventRecord): boolean {
  return isStreamEventType(event.eventType);
}

function matchesOnly(event: SessionEventRecord, only: SessionTraceOnlyFilter): boolean {
  if (only.raw.length === 0) return true;
  if (only.groups.includes(event.eventGroup.toLowerCase())) return true;
  if (only.eventTypes.includes(event.eventType.toLowerCase())) return true;
  return false;
}

function queryEvents(input: SessionTraceQueryInput, only: SessionTraceOnlyFilter): SessionEventRecord[] {
  const where: string[] = [];
  const params: SqlParam[] = [];

  addSessionFilter(where, params, input.session, input.sessionKey, input.sessionName);
  addTimeFilter(where, params, "timestamp", input.since, input.until);
  addExactFilter(where, params, "turn_id", input.turnId);
  addExactFilter(where, params, "run_id", input.runId);
  addExactFilter(where, params, "message_id", input.messageId);

  const sql = `
    SELECT *
    FROM session_events
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY timestamp ASC, seq ASC, id ASC
  `;

  let events = (
    getDb()
      .prepare(sql)
      .all(...params) as SessionEventRow[]
  ).map(rowToSessionEvent);

  if (!input.includeStream) {
    events = events.filter((event) => !isStreamEvent(event));
  }

  events = events.filter((event) => matchesOnly(event, only));

  const correlationId = compactText(input.correlationId);
  if (correlationId) {
    events = events.filter((event) => containsCorrelationId(event.payloadJson, correlationId));
  }

  return events;
}

function queryTurns(input: SessionTraceQueryInput, events: SessionEventRecord[], only: SessionTraceOnlyFilter) {
  if (only.raw.length > 0 && !only.includeTurns) {
    return [];
  }

  const where: string[] = [];
  const params: SqlParam[] = [];
  const restrictToEventTurns = Boolean(compactText(input.messageId) || compactText(input.correlationId));
  const eventTurnIds = Array.from(
    new Set(events.map((event) => event.turnId).filter((id): id is string => Boolean(id))),
  );

  addSessionFilter(where, params, input.session, input.sessionKey, input.sessionName);
  addExactFilter(where, params, "turn_id", input.turnId);
  addExactFilter(where, params, "run_id", input.runId);

  if (typeof input.since === "number" && Number.isFinite(input.since)) {
    where.push("COALESCE(completed_at, updated_at, started_at) >= ?");
    params.push(input.since);
  }
  if (typeof input.until === "number" && Number.isFinite(input.until)) {
    where.push("started_at <= ?");
    params.push(input.until);
  }

  if (restrictToEventTurns) {
    if (eventTurnIds.length === 0) {
      return [];
    }
    where.push(`turn_id IN (${eventTurnIds.map(() => "?").join(", ")})`);
    params.push(...eventTurnIds);
  }

  const sql = `
    SELECT *
    FROM session_turns
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY started_at ASC, turn_id ASC
  `;

  return (
    getDb()
      .prepare(sql)
      .all(...params) as SessionTurnRow[]
  ).map(rowToSessionTurn);
}

function normalizeLimit(limit: number | undefined): number | null {
  if (limit === undefined || limit === null) return null;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`Invalid trace limit: ${limit}. Use a positive integer.`);
  }
  return limit;
}

function applyTimelineLimit(
  events: SessionEventRecord[],
  turns: SessionTurnRecord[],
  limit: number | null,
): { events: SessionEventRecord[]; turns: SessionTurnRecord[] } {
  if (!limit) return { events, turns };

  const timeline = [
    ...events.map((event) => ({
      key: `${traceEventTimelineKey(event)}:event`,
      event,
      turn: null as SessionTurnRecord | null,
    })),
    ...turns.map((turn) => ({
      key: `${traceTurnTimelineKey(turn)}:turn`,
      event: null as SessionEventRecord | null,
      turn,
    })),
  ].sort((a, b) => a.key.localeCompare(b.key));

  const kept = timeline.slice(-limit);
  const keptEventIds = new Set(kept.map((item) => item.event?.id).filter((id): id is number => typeof id === "number"));
  const keptTurnIds = new Set(kept.map((item) => item.turn?.turnId).filter((id): id is string => Boolean(id)));

  return {
    events: events.filter((event) => keptEventIds.has(event.id)),
    turns: turns.filter((turn) => keptTurnIds.has(turn.turnId)),
  };
}

function traceEventTimelineKey(event: SessionEventRecord): string {
  return `${String(event.timestamp).padStart(16, "0")}:1:${String(event.seq).padStart(8, "0")}:${String(event.id).padStart(8, "0")}`;
}

function traceTurnTimelineKey(turn: SessionTurnRecord): string {
  return `${String(turn.startedAt).padStart(16, "0")}:0:${turn.turnId}`;
}

function queryBlobs(shas: Iterable<string>): Record<string, SessionTraceBlobRecord> {
  const unique = Array.from(
    new Set(
      Array.from(shas)
        .map(compactText)
        .filter((sha): sha is string => Boolean(sha)),
    ),
  );
  if (unique.length === 0) return {};

  const rows = getDb()
    .prepare(`SELECT * FROM session_trace_blobs WHERE sha256 IN (${unique.map(() => "?").join(", ")})`)
    .all(...unique) as SessionTraceBlobRow[];

  return Object.fromEntries(rows.map((row) => [row.sha256, rowToSessionTraceBlob(row)]));
}

function rowToSystemPromptSnapshot(
  row: SessionTurnRow,
  source: SessionTraceSystemPromptSnapshot["source"] = "turn",
): SessionTraceSystemPromptSnapshot | null {
  if (!row.system_prompt_sha256) return null;
  return {
    sha256: row.system_prompt_sha256,
    turnId: row.turn_id,
    runId: row.run_id,
    sessionKey: row.session_key,
    sessionName: row.session_name,
    agentId: row.agent_id,
    provider: row.provider,
    model: row.model,
    cwd: row.cwd,
    recordedAt: row.started_at,
    source,
  };
}

function getEventSystemPromptSha(event: SessionEventRecord): string | null {
  return getJsonPathString(event.payloadJson, ["system_prompt_sha256"]);
}

function getLatestSystemPromptFromTimeline(
  events: SessionEventRecord[],
  turns: SessionTurnRecord[],
): SessionTraceSystemPromptSnapshot | null {
  const turnSnapshots = turns
    .filter((turn) => Boolean(turn.systemPromptSha256))
    .map((turn) => ({
      key: `${String(turn.startedAt).padStart(16, "0")}:turn:${turn.turnId}`,
      snapshot: {
        sha256: turn.systemPromptSha256!,
        turnId: turn.turnId,
        runId: turn.runId,
        sessionKey: turn.sessionKey,
        sessionName: turn.sessionName,
        agentId: turn.agentId,
        provider: turn.provider,
        model: turn.model,
        cwd: turn.cwd,
        recordedAt: turn.startedAt,
        source: "turn" as const,
      },
    }));

  const eventSnapshots = events
    .filter((event) => event.eventType === "adapter.request")
    .map((event) => {
      const sha256 = getEventSystemPromptSha(event);
      if (!sha256) return null;
      return {
        key: `${String(event.timestamp).padStart(16, "0")}:event:${String(event.id).padStart(8, "0")}`,
        snapshot: {
          sha256,
          turnId: event.turnId,
          runId: event.runId,
          sessionKey: event.sessionKey,
          sessionName: event.sessionName,
          agentId: event.agentId,
          provider: event.provider,
          model: event.model,
          cwd: getJsonPathString(event.payloadJson, ["cwd"]),
          recordedAt: event.timestamp,
          source: "adapter.request" as const,
        },
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  return [...turnSnapshots, ...eventSnapshots].sort((a, b) => b.key.localeCompare(a.key))[0]?.snapshot ?? null;
}

function queryLatestSystemPromptSnapshot(input: SessionTraceQueryInput): SessionTraceSystemPromptSnapshot | null {
  const where: string[] = ["system_prompt_sha256 IS NOT NULL"];
  const params: SqlParam[] = [];

  addSessionFilter(where, params, input.session, input.sessionKey, input.sessionName);
  addExactFilter(where, params, "turn_id", input.turnId);
  addExactFilter(where, params, "run_id", input.runId);

  if (typeof input.until === "number" && Number.isFinite(input.until)) {
    where.push("started_at <= ?");
    params.push(input.until);
  }

  const row = getDb()
    .prepare(`
      SELECT *
      FROM session_turns
      WHERE ${where.join(" AND ")}
      ORDER BY started_at DESC, updated_at DESC, turn_id DESC
      LIMIT 1
    `)
    .get(...params) as SessionTurnRow | undefined;

  return row ? rowToSystemPromptSnapshot(row) : null;
}

export function parseSessionTraceTime(value: string | undefined, now = Date.now()): number | undefined {
  const text = compactText(value);
  if (!text) return undefined;

  const duration = text.match(/^(\d+(?:\.\d+)?)\s*(ms|s|sec|m|min|h|hr|d)$/i);
  if (duration) {
    const amount = Number.parseFloat(duration[1]!);
    const unit = duration[2]!.toLowerCase();
    const multiplier =
      unit === "ms"
        ? 1
        : unit === "s" || unit === "sec"
          ? 1_000
          : unit === "m" || unit === "min"
            ? 60_000
            : unit === "h" || unit === "hr"
              ? 3_600_000
              : 86_400_000;
    return now - amount * multiplier;
  }

  if (/^\d+$/.test(text)) {
    return Number.parseInt(text, 10);
  }

  const parsed = Date.parse(text);
  if (Number.isFinite(parsed)) {
    return parsed;
  }

  throw new Error(`Invalid trace time: ${value}. Use an ISO timestamp, epoch ms, or duration like 30m/2h/1d.`);
}

export function querySessionTrace(input: SessionTraceQueryInput): SessionTraceQueryResult {
  const only = normalizeSessionTraceOnly(input.only);
  const limit = normalizeLimit(input.limit);
  const queriedEvents = queryEvents(input, only);
  const queriedTurns = input.includeTurns === false ? [] : queryTurns(input, queriedEvents, only);
  const { events, turns } = applyTimelineLimit(queriedEvents, queriedTurns, limit);
  const requestedBlobs = new Set<string>();
  const systemPrompt = input.showSystemPrompt
    ? (getLatestSystemPromptFromTimeline(events, turns) ?? queryLatestSystemPromptSnapshot(input))
    : null;

  if (systemPrompt) {
    requestedBlobs.add(systemPrompt.sha256);
  }

  for (const turn of turns) {
    if (input.raw && turn.requestBlobSha256) {
      requestedBlobs.add(turn.requestBlobSha256);
    }
    if (input.showSystemPrompt && turn.systemPromptSha256) {
      requestedBlobs.add(turn.systemPromptSha256);
    }
    if (input.showUserPrompt && turn.userPromptSha256) {
      requestedBlobs.add(turn.userPromptSha256);
    }
  }

  if (input.raw) {
    for (const event of events) {
      collectRawBlobReferences(event.payloadJson, requestedBlobs);
    }
  }

  const firstEvent = events[0] ?? null;
  const firstTurn = turns[0] ?? null;

  return {
    session: input.session ?? input.sessionName ?? input.sessionKey ?? null,
    sessionKey: firstTurn?.sessionKey ?? firstEvent?.sessionKey ?? input.sessionKey ?? null,
    sessionName: firstTurn?.sessionName ?? firstEvent?.sessionName ?? input.sessionName ?? null,
    systemPrompt,
    filters: {
      since: input.since ?? null,
      until: input.until ?? null,
      limit,
      turnId: input.turnId ?? null,
      runId: input.runId ?? null,
      messageId: input.messageId ?? null,
      correlationId: input.correlationId ?? null,
      only,
      includeStream: Boolean(input.includeStream),
      raw: Boolean(input.raw),
      showSystemPrompt: Boolean(input.showSystemPrompt),
      showUserPrompt: Boolean(input.showUserPrompt),
    },
    events,
    turns,
    blobsBySha256: queryBlobs(requestedBlobs),
  };
}

export function getJsonPathString(value: JsonValue | null, path: string[]): string | null {
  let current: JsonValue | null = value;
  for (const segment of path) {
    if (!isRecord(current)) return null;
    current = current[segment] ?? null;
  }
  if (typeof current === "string") return current;
  if (typeof current === "number" || typeof current === "boolean") return String(current);
  return null;
}

export function getJsonPathNumber(value: JsonValue | null, path: string[]): number | null {
  let current: JsonValue | null = value;
  for (const segment of path) {
    if (!isRecord(current)) return null;
    current = current[segment] ?? null;
  }
  if (typeof current === "number" && Number.isFinite(current)) return current;
  if (typeof current === "string" && current.trim() && Number.isFinite(Number(current))) return Number(current);
  return null;
}
