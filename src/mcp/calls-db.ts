/**
 * MCP calls that left their turn (spec mcp, Background Calls And Tasks).
 *
 * A call detaches when the server answers with a task, or when it is still
 * running at the end of its inline budget. From then on `mcp_calls` holds it
 * until its outcome is delivered to the session it came from:
 *
 * - `running`: a request the daemon keeps open past the budget (in memory of
 *   the daemon that owns it; a daemon restart makes it `lost`);
 * - `task`: a remote task the follower polls with `tasks/get`;
 * - `delivering`: the outcome is known and waits for the session queue;
 * - `delivered`: the session queue took it (the result text is cleared);
 * - `failed`: the session queue refused it on every retry (cleared too).
 *
 * `outcome` says what is delivered: `ok`, `tool_error`, `error`, `cancelled`,
 * `expired` (the server forgot the task, or its time ran out), `lost` (a
 * daemon restart dropped a kept request; the outcome on the server is
 * unknown) or `discarded` (the server was removed, disabled or detached, so
 * only a note is delivered).
 *
 * Arguments are never stored. `result_json` holds only the capped text the
 * delivery shows, and is cleared once the call is delivered or failed.
 */

import { randomBytes } from "node:crypto";

import { getDb } from "../router/router-db.js";
import type { McpEra } from "./registry-db.js";

export type McpCallState = "running" | "task" | "delivering" | "delivered" | "failed";
export type McpCallOutcome = "ok" | "tool_error" | "error" | "cancelled" | "expired" | "lost" | "discarded";
export type McpCallDetachReason = "task" | "budget";

export const MCP_CALL_STATES: readonly McpCallState[] = ["running", "task", "delivering", "delivered", "failed"];
export const MCP_CALL_OPEN_STATES: readonly McpCallState[] = ["running", "task", "delivering"];
export const MCP_CALL_OUTCOMES: readonly McpCallOutcome[] = [
  "ok",
  "tool_error",
  "error",
  "cancelled",
  "expired",
  "lost",
  "discarded",
];

/** A call id: `mc_` and 26 lowercase base-32 characters (time first, so ids sort by creation). */
export const MCP_CALL_ID_PATTERN = /^mc_[0-9a-z]{26}$/;
const MAX_LAST_ERROR = 500;

/** Who the call was made for, kept to bind a task's late input to the same person. */
export interface McpCallOrigin {
  /** The turn's context record (re-read when the server asks a late question). */
  contextId: string | null;
  /** The person of that turn, or null when the turn had none (a routine, a relay, the terminal). */
  contactId: string | null;
  /** The turn was the operator's own. */
  operatorOwn: boolean;
}

/** The delivery text of a finished call, already capped. Never arguments, never a secret Ravi holds. */
export interface McpStoredCallResult {
  outcome: McpCallOutcome;
  /** The remote text (results, a task's status message) or Ravi's own note. */
  text: string;
  /** Text that comes from Ravi, not from the server (a cancel race, a discard). */
  note?: string;
  truncated: boolean;
}

export interface McpCallRecord {
  id: string;
  server: string;
  /**
   * The registration the call went to (the server row's `createdAt` when it
   * detached; null on rows written before it was recorded). A server removed
   * and registered again under the same name is another server.
   */
  serverCreatedAt: number | null;
  /** The call declared the files extension (an upload call); its task polls declare it too. */
  filesUpload: boolean;
  tool: string;
  agentId: string;
  sessionName: string;
  sessionKey: string | null;
  origin: McpCallOrigin;
  surface: string;
  era: McpEra | null;
  detachReason: McpCallDetachReason;
  state: McpCallState;
  outcome: McpCallOutcome | null;
  remoteTaskId: string | null;
  taskStatus: string | null;
  pollIntervalMs: number | null;
  nextPollAt: number | null;
  expiresAt: number;
  cancelRequestedAt: number | null;
  cancelSentAt: number | null;
  result: McpStoredCallResult | null;
  inputRounds: number;
  pollFailures: number;
  deliveryAttempts: number;
  lastError: string | null;
  rateLimitedAt: number | null;
  rateLimitedUntil: number | null;
  owner: string | null;
  createdAt: number;
  updatedAt: number;
  deliveredAt: number | null;
}

interface McpCallRow {
  id: string;
  server: string;
  server_created_at: number | null;
  files_upload?: number | null;
  tool: string;
  agent_id: string;
  session_name: string;
  session_key: string | null;
  origin_json: string;
  surface: string;
  era: string | null;
  detach_reason: string;
  state: string;
  outcome: string | null;
  remote_task_id: string | null;
  task_status: string | null;
  poll_interval_ms: number | null;
  next_poll_at: number | null;
  expires_at: number;
  cancel_requested_at: number | null;
  cancel_sent_at: number | null;
  result_json: string | null;
  input_rounds: number;
  poll_failures: number;
  delivery_attempts: number;
  last_error: string | null;
  rate_limited_at: number | null;
  rate_limited_until: number | null;
  owner: string | null;
  created_at: number;
  updated_at: number;
  delivered_at: number | null;
}

// ============================================================================
// Ids and mapping
// ============================================================================

const BASE32 = "0123456789abcdefghjkmnpqrstvwxyz";

/** A new call id: 10 characters of time and 16 of randomness. */
export function newMcpCallId(now: number = Date.now()): string {
  let time = "";
  let value = Math.max(0, Math.trunc(now));
  for (let i = 0; i < 10; i++) {
    time = BASE32[value % 32] + time;
    value = Math.floor(value / 32);
  }
  const bytes = randomBytes(16);
  let random = "";
  for (const byte of bytes) random += BASE32[byte % 32];
  return `mc_${time}${random}`;
}

function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

function parseOrigin(value: string): McpCallOrigin {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(value);
  } catch {
    // no-cause: a damaged origin names no person, so a late question is declined.
    parsed = null;
  }
  const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  return {
    contextId: typeof record.contextId === "string" ? record.contextId : null,
    contactId: typeof record.contactId === "string" ? record.contactId : null,
    operatorOwn: record.operatorOwn === true,
  };
}

function parseResult(value: string | null): McpStoredCallResult | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const outcome = oneOf(typeof parsed.outcome === "string" ? parsed.outcome : null, MCP_CALL_OUTCOMES);
    if (!outcome || typeof parsed.text !== "string") return null;
    return {
      outcome,
      text: parsed.text,
      ...(typeof parsed.note === "string" ? { note: parsed.note } : {}),
      truncated: parsed.truncated === true,
    };
  } catch {
    // no-cause: a result that does not parse delivers as an error note, never as raw stored text.
    return null;
  }
}

function rowToCall(row: McpCallRow): McpCallRecord {
  return {
    id: row.id,
    server: row.server,
    serverCreatedAt: row.server_created_at ?? null,
    filesUpload: row.files_upload === 1,
    tool: row.tool,
    agentId: row.agent_id,
    sessionName: row.session_name,
    sessionKey: row.session_key,
    origin: parseOrigin(row.origin_json),
    surface: row.surface,
    era: row.era === "modern" || row.era === "legacy" ? row.era : null,
    detachReason: row.detach_reason === "task" ? "task" : "budget",
    // An unknown stored state is read as finished: nothing acts on a damaged row.
    state: oneOf(row.state, MCP_CALL_STATES) ?? "failed",
    outcome: oneOf(row.outcome, MCP_CALL_OUTCOMES),
    remoteTaskId: row.remote_task_id,
    taskStatus: row.task_status,
    pollIntervalMs: row.poll_interval_ms,
    nextPollAt: row.next_poll_at,
    expiresAt: row.expires_at,
    cancelRequestedAt: row.cancel_requested_at,
    cancelSentAt: row.cancel_sent_at,
    result: parseResult(row.result_json),
    inputRounds: row.input_rounds,
    pollFailures: row.poll_failures,
    deliveryAttempts: row.delivery_attempts,
    lastError: row.last_error,
    rateLimitedAt: row.rate_limited_at,
    rateLimitedUntil: row.rate_limited_until,
    owner: row.owner,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at,
  };
}

function cutText(value: string | null | undefined, max = MAX_LAST_ERROR): string | null {
  if (value === null || value === undefined) return null;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

// ============================================================================
// Writes
// ============================================================================

export interface CreateMcpCallInput {
  id?: string;
  server: string;
  /** The server row's `createdAt` (its registration). */
  serverCreatedAt?: number | null;
  filesUpload?: boolean;
  tool: string;
  agentId: string;
  sessionName: string;
  sessionKey?: string | null;
  origin: McpCallOrigin;
  surface: string;
  era?: McpEra | null;
  detachReason: McpCallDetachReason;
  state: Extract<McpCallState, "running" | "task">;
  remoteTaskId?: string | null;
  taskStatus?: string | null;
  pollIntervalMs?: number | null;
  nextPollAt?: number | null;
  expiresAt: number;
  owner?: string | null;
  now?: number;
}

export function createMcpCall(input: CreateMcpCallInput): McpCallRecord {
  const now = input.now ?? Date.now();
  const id = input.id ?? newMcpCallId(now);
  if (!MCP_CALL_ID_PATTERN.test(id)) throw new Error("An MCP call id must match mc_<26 base-32 characters>.");
  if (!input.sessionName.trim()) throw new Error("A detached MCP call needs the session its result goes to.");
  getDb()
    .prepare(
      `INSERT INTO mcp_calls (
        id, server, server_created_at, files_upload, tool, agent_id, session_name, session_key, origin_json, surface,
        era, detach_reason, state, remote_task_id, task_status, poll_interval_ms, next_poll_at, expires_at, owner,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.server,
      input.serverCreatedAt ?? null,
      input.filesUpload ? 1 : 0,
      input.tool,
      input.agentId,
      input.sessionName,
      input.sessionKey ?? null,
      JSON.stringify({
        contextId: input.origin.contextId,
        contactId: input.origin.contactId,
        operatorOwn: input.origin.operatorOwn,
      }),
      input.surface,
      input.era ?? null,
      input.detachReason,
      input.state,
      input.remoteTaskId ?? null,
      input.taskStatus ?? null,
      input.pollIntervalMs ?? null,
      input.nextPollAt ?? null,
      input.expiresAt,
      input.owner ?? null,
      now,
      now,
    );
  const created = getMcpCall(id);
  if (!created) throw new Error("The MCP call row could not be read back.");
  return created;
}

export interface McpCallPatch {
  state?: McpCallState;
  outcome?: McpCallOutcome | null;
  remoteTaskId?: string | null;
  taskStatus?: string | null;
  pollIntervalMs?: number | null;
  nextPollAt?: number | null;
  expiresAt?: number;
  cancelSentAt?: number | null;
  result?: McpStoredCallResult | null;
  inputRounds?: number;
  pollFailures?: number;
  deliveryAttempts?: number;
  lastError?: string | null;
  rateLimitedAt?: number | null;
  rateLimitedUntil?: number | null;
  owner?: string | null;
  deliveredAt?: number | null;
}

/** What a compare-and-swap update expects the row to hold before it writes. */
export interface McpCallExpect {
  state?: McpCallState | readonly McpCallState[];
  /** The claim the writer holds (`next_poll_at`); null expects none. */
  nextPollAt?: number | null;
}

const PATCH_COLUMNS: Record<keyof McpCallPatch, string> = {
  state: "state",
  outcome: "outcome",
  remoteTaskId: "remote_task_id",
  taskStatus: "task_status",
  pollIntervalMs: "poll_interval_ms",
  nextPollAt: "next_poll_at",
  expiresAt: "expires_at",
  cancelSentAt: "cancel_sent_at",
  result: "result_json",
  inputRounds: "input_rounds",
  pollFailures: "poll_failures",
  deliveryAttempts: "delivery_attempts",
  lastError: "last_error",
  rateLimitedAt: "rate_limited_at",
  rateLimitedUntil: "rate_limited_until",
  owner: "owner",
  deliveredAt: "delivered_at",
};

/**
 * Update a call. With `expect`, the write happens only when the row still
 * holds that state (and claim): two writers never both move one call.
 * Returns the updated row, or null when nothing was written.
 */
export function updateMcpCall(
  id: string,
  patch: McpCallPatch,
  expect: McpCallExpect = {},
  now: number = Date.now(),
): McpCallRecord | null {
  const sets: string[] = ["updated_at = ?"];
  const values: (string | number | null)[] = [now];
  for (const [key, column] of Object.entries(PATCH_COLUMNS) as [keyof McpCallPatch, string][]) {
    if (!(key in patch)) continue;
    const value = patch[key];
    sets.push(`${column} = ?`);
    if (key === "result") values.push(value ? JSON.stringify(value) : null);
    else if (key === "lastError") values.push(cutText(value as string | null));
    else values.push((value as string | number | null | undefined) ?? null);
  }
  const where: string[] = ["id = ?"];
  const whereValues: (string | number | null)[] = [id];
  if (expect.state !== undefined) {
    const states = typeof expect.state === "string" ? [expect.state] : [...expect.state];
    where.push(`state IN (${states.map(() => "?").join(", ")})`);
    whereValues.push(...states);
  }
  if (expect.nextPollAt !== undefined) {
    if (expect.nextPollAt === null) where.push("next_poll_at IS NULL");
    else {
      where.push("next_poll_at = ?");
      whereValues.push(expect.nextPollAt);
    }
  }
  const result = getDb()
    .prepare(`UPDATE mcp_calls SET ${sets.join(", ")} WHERE ${where.join(" AND ")}`)
    .run(...values, ...whereValues);
  return result.changes > 0 ? getMcpCall(id) : null;
}

/**
 * Ask for a call to be cancelled. Only open calls (`running`, `task`) take a
 * request; a repeat keeps the first time. Returns the row, or null when there
 * is none.
 */
export function requestMcpCallCancel(id: string, now: number = Date.now()): McpCallRecord | null {
  getDb()
    .prepare(
      `UPDATE mcp_calls SET cancel_requested_at = ?, updated_at = ?
       WHERE id = ? AND state IN ('running', 'task') AND cancel_requested_at IS NULL`,
    )
    .run(now, now, id);
  return getMcpCall(id);
}

/** Ask for every open call of a server to be cancelled (`ravi mcp remove`). Returns how many. */
export function requestMcpCallsCancelForServer(server: string, now: number = Date.now()): number {
  return getDb()
    .prepare(
      `UPDATE mcp_calls SET cancel_requested_at = ?, updated_at = ?
       WHERE server = ? AND state IN ('running', 'task') AND cancel_requested_at IS NULL`,
    )
    .run(now, now, server).changes;
}

// ============================================================================
// Reads
// ============================================================================

export function getMcpCall(id: string): McpCallRecord | null {
  const row = getDb().prepare("SELECT * FROM mcp_calls WHERE id = ?").get(id) as McpCallRow | null;
  return row ? rowToCall(row) : null;
}

export interface ListMcpCallsFilter {
  agentId?: string;
  sessionName?: string;
  server?: string;
  states?: readonly McpCallState[];
  /**
   * Only these calls: those whose (server, tool) is one of `pairs`, or whose
   * id is one of `ids`. Both empty matches nothing. Used for a turn that sees
   * only the calls it may use (spec mcp, Management CLI).
   */
  visible?: { pairs: ReadonlyArray<{ server: string; tool: string }>; ids: readonly string[] };
  limit?: number;
  offset?: number;
}

function filterSql(filter: ListMcpCallsFilter): { where: string; values: (string | number)[] } {
  const where: string[] = [];
  const values: (string | number)[] = [];
  if (filter.agentId !== undefined) {
    where.push("agent_id = ?");
    values.push(filter.agentId);
  }
  if (filter.sessionName !== undefined) {
    where.push("session_name = ?");
    values.push(filter.sessionName);
  }
  if (filter.server !== undefined) {
    where.push("server = ?");
    values.push(filter.server);
  }
  if (filter.states && filter.states.length > 0) {
    where.push(`state IN (${filter.states.map(() => "?").join(", ")})`);
    values.push(...filter.states);
  }
  if (filter.visible) {
    const alternatives: string[] = [];
    for (const pair of filter.visible.pairs) {
      alternatives.push("(server = ? AND tool = ?)");
      values.push(pair.server, pair.tool);
    }
    if (filter.visible.ids.length > 0) {
      alternatives.push(`id IN (${filter.visible.ids.map(() => "?").join(", ")})`);
      values.push(...filter.visible.ids);
    }
    where.push(alternatives.length ? `(${alternatives.join(" OR ")})` : "0");
  }
  return { where: where.length ? `WHERE ${where.join(" AND ")}` : "", values };
}

/** The distinct (server, tool) pairs of the calls a filter matches (its `visible` and paging are ignored). */
export function listMcpCallServerTools(
  filter: Omit<ListMcpCallsFilter, "visible" | "limit" | "offset"> = {},
): Array<{ server: string; tool: string }> {
  const { where, values } = filterSql(filter);
  return getDb()
    .prepare(`SELECT DISTINCT server, tool FROM mcp_calls ${where} ORDER BY server, tool`)
    .all(...values) as Array<{ server: string; tool: string }>;
}

/** Calls, newest first. */
export function listMcpCalls(filter: ListMcpCallsFilter = {}): McpCallRecord[] {
  const { where, values } = filterSql(filter);
  const limit = Math.max(1, Math.min(500, Math.trunc(filter.limit ?? 100)));
  const offset = Math.max(0, Math.trunc(filter.offset ?? 0));
  const rows = getDb()
    .prepare(`SELECT * FROM mcp_calls ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...values, limit, offset) as McpCallRow[];
  return rows.map(rowToCall);
}

export function countMcpCalls(filter: Omit<ListMcpCallsFilter, "limit" | "offset"> = {}): number {
  const { where, values } = filterSql(filter);
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM mcp_calls ${where}`)
    .get(...values) as { n: number };
  return row.n;
}

/**
 * Calls the follower must look at now: tasks and deliveries whose time has
 * come, and tasks with a cancel request not yet sent.
 */
export function listDueMcpCalls(now: number, limit = 100): McpCallRecord[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM mcp_calls
       WHERE (state IN ('task', 'delivering') AND (next_poll_at IS NULL OR next_poll_at <= ?))
          OR (state = 'task' AND cancel_requested_at IS NOT NULL AND cancel_sent_at IS NULL)
       ORDER BY COALESCE(next_poll_at, 0), created_at LIMIT ?`,
    )
    .all(now, Math.max(1, Math.trunc(limit))) as McpCallRow[];
  return rows.map(rowToCall);
}

/** Calls in one state (the follower's restart recovery and cancel checks). */
export function listMcpCallsInState(state: McpCallState, limit = 500): McpCallRecord[] {
  const rows = getDb()
    .prepare("SELECT * FROM mcp_calls WHERE state = ? ORDER BY created_at LIMIT ?")
    .all(state, Math.max(1, Math.trunc(limit))) as McpCallRow[];
  return rows.map(rowToCall);
}

/**
 * Record a server's HTTP 429 answer (the method that got it, never its body).
 * This row is the server's one back-off, honoured by every request Ravi sends
 * it (`readMcpServerBackoff`). A later answer never shortens a back-off that
 * still holds: the stored end is the later of the two.
 */
export function recordMcpServerRateLimit(
  server: string,
  method: string,
  until: number,
  now: number = Date.now(),
): void {
  getDb()
    .prepare(
      `INSERT INTO mcp_server_rate_limits (server, limited_at, limited_until, method) VALUES (?, ?, ?, ?)
       ON CONFLICT(server) DO UPDATE SET limited_at = excluded.limited_at,
         limited_until = MAX(limited_until, excluded.limited_until), method = excluded.method`,
    )
    .run(server, now, until, method.slice(0, 64));
}

/** When the server's back-off ends (epoch ms), or null when none holds at `now`. */
export function readMcpServerBackoff(server: string, now: number = Date.now()): number | null {
  const row = getDb().prepare("SELECT limited_until FROM mcp_server_rate_limits WHERE server = ?").get(server) as {
    limited_until: number;
  } | null;
  return row && row.limited_until > now ? row.limited_until : null;
}

/** What `ravi mcp show` reports about a server's background calls and its last rate limit. */
export function mcpServerCallSummary(server: string): {
  open: number;
  lastRateLimitedAt: number | null;
  rateLimitedUntil: number | null;
  rateLimitedMethod: string | null;
} {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT SUM(CASE WHEN state IN ('running', 'task', 'delivering') THEN 1 ELSE 0 END) AS open
       FROM mcp_calls WHERE server = ?`,
    )
    .get(server) as { open: number | null };
  const limit = db
    .prepare("SELECT limited_at, limited_until, method FROM mcp_server_rate_limits WHERE server = ?")
    .get(server) as { limited_at: number; limited_until: number; method: string } | null;
  return {
    open: row.open ?? 0,
    lastRateLimitedAt: limit?.limited_at ?? null,
    rateLimitedUntil: limit?.limited_until ?? null,
    rateLimitedMethod: limit?.method ?? null,
  };
}

/** Forget a removed server's rate-limit record. */
export function clearMcpServerRateLimit(server: string): void {
  getDb().prepare("DELETE FROM mcp_server_rate_limits WHERE server = ?").run(server);
}
