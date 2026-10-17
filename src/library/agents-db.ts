/**
 * Local state of Library agents in `ravi.db` (spec skills/library).
 *
 * `library_agents`: per local agent, the description the directory shows,
 * whether the operator opened it to requests from other installations
 * (default closed), and the Library definition it was installed from (ref,
 * version, and the hashes of `AGENTS.md`/`HEARTBEAT.md` as installed, so an
 * update can tell a local edit from an untouched file).
 *
 * `library_agent_requests`: requests between agents as this side knows them.
 * A sent request remembers the asking session, so its answer goes back there;
 * a received one tracks the turn that answers it.
 */

import { getDb } from "../router/router-db.js";

export const LIBRARY_AGENT_DESCRIPTION_MAX = 300;

export interface LibraryAgentOrigin {
  ref: string;
  version: number;
  contentHash: string | null;
  agentsMdSha256: string | null;
  heartbeatMdSha256: string | null;
  /** The profile and skills the installed version asked for (what was applied is the agent's own config). */
  profile: string | null;
  skills: string[];
  installedAt: number | null;
}

export interface LibraryAgentState {
  agentId: string;
  description: string | null;
  acceptsRequests: boolean;
  origin: LibraryAgentOrigin | null;
  updatedAt: number;
}

interface AgentRow {
  agent_id: string;
  description: string | null;
  accepts_requests: number;
  origin_ref: string | null;
  origin_version: number | null;
  origin_content_hash: string | null;
  agents_md_sha256: string | null;
  heartbeat_md_sha256: string | null;
  origin_profile: string | null;
  origin_skills_json: string | null;
  installed_at: number | null;
  updated_at: number;
}

function rowToState(row: AgentRow): LibraryAgentState {
  let skills: string[] = [];
  try {
    const parsed = row.origin_skills_json ? (JSON.parse(row.origin_skills_json) as unknown) : [];
    if (Array.isArray(parsed)) skills = parsed.filter((ref): ref is string => typeof ref === "string");
  } catch {
    skills = [];
  }
  return {
    agentId: row.agent_id,
    description: row.description,
    acceptsRequests: row.accepts_requests === 1,
    origin:
      row.origin_ref && row.origin_version !== null
        ? {
            ref: row.origin_ref,
            version: row.origin_version,
            contentHash: row.origin_content_hash,
            agentsMdSha256: row.agents_md_sha256,
            heartbeatMdSha256: row.heartbeat_md_sha256,
            profile: row.origin_profile,
            skills,
            installedAt: row.installed_at,
          }
        : null,
    updatedAt: row.updated_at,
  };
}

export function dbGetLibraryAgentState(agentId: string): LibraryAgentState | null {
  const row = getDb().prepare("SELECT * FROM library_agents WHERE agent_id = ?").get(agentId) as AgentRow | null;
  return row ? rowToState(row) : null;
}

export function dbListLibraryAgentStates(): LibraryAgentState[] {
  const rows = getDb().prepare("SELECT * FROM library_agents ORDER BY agent_id").all() as AgentRow[];
  return rows.map(rowToState);
}

/** Never throws: an unreadable table means no description and closed to requests. */
export function readLibraryAgentState(agentId: string): LibraryAgentState | null {
  try {
    return dbGetLibraryAgentState(agentId);
  } catch {
    return null;
  }
}

function ensureRow(agentId: string, now: number): void {
  getDb()
    .prepare("INSERT INTO library_agents (agent_id, updated_at) VALUES (?, ?) ON CONFLICT(agent_id) DO NOTHING")
    .run(agentId, now);
}

export function dbSetLibraryAgentDescription(agentId: string, description: string | null, now = Date.now()): void {
  ensureRow(agentId, now);
  getDb()
    .prepare("UPDATE library_agents SET description = ?, updated_at = ? WHERE agent_id = ?")
    .run(description, now, agentId);
}

export function dbSetLibraryAgentAcceptsRequests(agentId: string, accepts: boolean, now = Date.now()): void {
  ensureRow(agentId, now);
  getDb()
    .prepare("UPDATE library_agents SET accepts_requests = ?, updated_at = ? WHERE agent_id = ?")
    .run(accepts ? 1 : 0, now, agentId);
}

export function dbSetLibraryAgentOrigin(agentId: string, origin: LibraryAgentOrigin, now = Date.now()): void {
  ensureRow(agentId, now);
  getDb()
    .prepare(
      `UPDATE library_agents
          SET origin_ref = ?, origin_version = ?, origin_content_hash = ?, agents_md_sha256 = ?,
              heartbeat_md_sha256 = ?, origin_profile = ?, origin_skills_json = ?, installed_at = ?, updated_at = ?
        WHERE agent_id = ?`,
    )
    .run(
      origin.ref,
      origin.version,
      origin.contentHash,
      origin.agentsMdSha256,
      origin.heartbeatMdSha256,
      origin.profile,
      JSON.stringify(origin.skills),
      origin.installedAt ?? now,
      now,
      agentId,
    );
}

// ---------------------------------------------------------------------------
// Requests

export type LocalRequestDirection = "sent" | "received";

export interface LocalAgentRequest {
  requestId: string;
  direction: LocalRequestDirection;
  /** The asking agent (sent) or the asked one (received); null when the operator asked from the terminal. */
  agentId: string | null;
  /** `<installation>/<agent>` of the other side, for display. */
  peer: string | null;
  sessionKey: string | null;
  sessionName: string | null;
  /** sent: `open`, then the Console's `answered`, `failed`, `expired` or `cancelled`; received: `running`, `answered`, `failed`. */
  status: string;
  error: string | null;
  /** The answer (sent) or the reply this side posted (received), kept for the terminal. */
  reply: string | null;
  createdAt: number;
  updatedAt: number;
}

interface RequestRow {
  request_id: string;
  direction: LocalRequestDirection;
  agent_id: string | null;
  peer: string | null;
  session_key: string | null;
  session_name: string | null;
  status: string;
  error: string | null;
  reply: string | null;
  created_at: number;
  updated_at: number;
}

function rowToRequest(row: RequestRow): LocalAgentRequest {
  return {
    requestId: row.request_id,
    direction: row.direction,
    agentId: row.agent_id,
    peer: row.peer,
    sessionKey: row.session_key,
    sessionName: row.session_name,
    status: row.status,
    error: row.error,
    reply: row.reply ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function dbUpsertLocalAgentRequest(
  input: Omit<LocalAgentRequest, "createdAt" | "updatedAt" | "error" | "reply"> & {
    error?: string | null;
    reply?: string | null;
    now?: number;
  },
): void {
  const now = input.now ?? Date.now();
  getDb()
    .prepare(
      `INSERT INTO library_agent_requests
         (request_id, direction, agent_id, peer, session_key, session_name, status, error, reply, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(request_id, direction) DO UPDATE SET
         status = excluded.status,
         error = excluded.error,
         reply = coalesce(excluded.reply, library_agent_requests.reply),
         updated_at = excluded.updated_at`,
    )
    .run(
      input.requestId,
      input.direction,
      input.agentId,
      input.peer,
      input.sessionKey,
      input.sessionName,
      input.status,
      input.error ?? null,
      input.reply ?? null,
      now,
      now,
    );
}

export function dbSetLocalAgentRequestStatus(
  requestId: string,
  direction: LocalRequestDirection,
  status: string,
  options: { error?: string | null; reply?: string | null; now?: number } = {},
): void {
  getDb()
    .prepare(
      `UPDATE library_agent_requests
          SET status = ?, error = ?, reply = coalesce(?, reply), updated_at = ?
        WHERE request_id = ? AND direction = ?`,
    )
    .run(status, options.error ?? null, options.reply ?? null, options.now ?? Date.now(), requestId, direction);
}

export function dbGetLocalAgentRequest(requestId: string, direction: LocalRequestDirection): LocalAgentRequest | null {
  const row = getDb()
    .prepare("SELECT * FROM library_agent_requests WHERE request_id = ? AND direction = ?")
    .get(requestId, direction) as RequestRow | null;
  return row ? rowToRequest(row) : null;
}

export function dbListLocalAgentRequests(filter: { direction?: LocalRequestDirection; status?: string } = {}) {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filter.direction) {
    clauses.push("direction = ?");
    params.push(filter.direction);
  }
  if (filter.status) {
    clauses.push("status = ?");
    params.push(filter.status);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(`SELECT * FROM library_agent_requests ${where} ORDER BY created_at DESC LIMIT 500`)
    .all(...params) as RequestRow[];
  return rows.map(rowToRequest);
}
