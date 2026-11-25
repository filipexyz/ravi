/**
 * Remote skill pins in `ravi.db` (spec mcp, Remote Skills).
 *
 * One row per (agent, server, skill URI): the manifest the operator approved
 * (`manifest_json`, `manifest_digest`), the plugin skill name the runtimes
 * know the stub by, and whether it loads outside the operator's own turns.
 * A pin is `active` or `stale` (the server's manifest no longer matches the
 * approved one, or the server no longer has the skill); a stale pin loads
 * nothing until it is pinned again, except a pin stale only because the skill
 * was `gone`, which comes back by itself when the server lists the skill with
 * exactly the approved digest. No skill file is ever stored here.
 */

import { getDb } from "../router/router-db.js";

export const MCP_SKILL_PIN_STATES = ["active", "stale"] as const;
export type McpSkillPinState = (typeof MCP_SKILL_PIN_STATES)[number];

/** Why a pin went stale (fixed codes; never remote text). */
export const MCP_SKILL_STALE_REASONS = ["manifest_changed", "digest_mismatch", "dynamic", "gone"] as const;
export type McpSkillStaleReason = (typeof MCP_SKILL_STALE_REASONS)[number];

export interface McpSkillManifestResource {
  uri: string;
  digest: string;
  size: number;
}

/** The canonical manifest a pin binds to. */
export interface McpSkillManifest {
  uri: string;
  name: string;
  description: string;
  resources: McpSkillManifestResource[];
}

export interface McpSkillPinRecord {
  agentId: string;
  server: string;
  skillUri: string;
  /** `mcp:<server>:<path>`. */
  skillId: string;
  /** Plugin skill name (`mcp-<server>-<slug>`, at most 64 characters). */
  skillName: string;
  description: string;
  manifest: McpSkillManifest;
  manifestDigest: string;
  /** `_meta["bot.ravi/library"].ref` of the entry, when the server gave one. */
  libraryRef: string | null;
  externalAllowed: boolean;
  state: McpSkillPinState;
  staleReason: McpSkillStaleReason | null;
  approvedBy: string | null;
  approvedAt: number;
  updatedAt: number;
}

interface PinRow {
  agent_id: string;
  server: string;
  skill_uri: string;
  skill_id: string;
  skill_name: string;
  description: string;
  manifest_json: string;
  manifest_digest: string;
  library_ref: string | null;
  external_allowed: number;
  state: string;
  stale_reason: string | null;
  approved_by: string | null;
  approved_at: number;
  updated_at: number;
}

function rowToPin(row: PinRow): McpSkillPinRecord | null {
  let manifest: McpSkillManifest;
  try {
    manifest = JSON.parse(row.manifest_json) as McpSkillManifest;
  } catch {
    // no-cause: an unreadable manifest is no approval; the row is left out (fail closed).
    return null;
  }
  if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.resources)) return null;
  const state = (MCP_SKILL_PIN_STATES as readonly string[]).includes(row.state)
    ? (row.state as McpSkillPinState)
    : "stale";
  const staleReason = (MCP_SKILL_STALE_REASONS as readonly string[]).includes(row.stale_reason ?? "")
    ? (row.stale_reason as McpSkillStaleReason)
    : null;
  return {
    agentId: row.agent_id,
    server: row.server,
    skillUri: row.skill_uri,
    skillId: row.skill_id,
    skillName: row.skill_name,
    description: row.description,
    manifest,
    manifestDigest: row.manifest_digest,
    libraryRef: row.library_ref,
    externalAllowed: row.external_allowed === 1,
    state,
    staleReason: state === "stale" ? staleReason : null,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    updatedAt: row.updated_at,
  };
}

function rows(sql: string, ...params: Array<string | number>): McpSkillPinRecord[] {
  const found = getDb()
    .prepare(sql)
    .all(...params) as PinRow[];
  return found.map(rowToPin).filter((row): row is McpSkillPinRecord => row !== null);
}

export interface ListMcpSkillPinsFilter {
  agentId?: string;
  server?: string;
  state?: McpSkillPinState;
}

export function listMcpSkillPins(filter: ListMcpSkillPinsFilter = {}): McpSkillPinRecord[] {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.agentId !== undefined) {
    where.push("agent_id = ?");
    params.push(filter.agentId);
  }
  if (filter.server !== undefined) {
    where.push("server = ?");
    params.push(filter.server);
  }
  if (filter.state !== undefined) {
    where.push("state = ?");
    params.push(filter.state);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return rows(`SELECT * FROM mcp_skill_pins ${clause} ORDER BY agent_id, server, skill_uri`, ...params);
}

export function getMcpSkillPin(agentId: string, server: string, skillUri: string): McpSkillPinRecord | null {
  return (
    rows(
      "SELECT * FROM mcp_skill_pins WHERE agent_id = ? AND server = ? AND skill_uri = ?",
      agentId,
      server,
      skillUri,
    )[0] ?? null
  );
}

/**
 * The active pins an agent may load now: the server is registered and
 * enabled, and still attached to that agent. Without `agentId`, every agent's.
 */
export function listLoadableMcpSkillPins(agentId?: string): McpSkillPinRecord[] {
  const base = `SELECT p.* FROM mcp_skill_pins p
      JOIN mcp_servers s ON s.name = p.server AND s.enabled = 1
      JOIN mcp_agent_servers a ON a.agent_id = p.agent_id AND a.server = p.server
     WHERE p.state = 'active'`;
  return agentId === undefined
    ? rows(`${base} ORDER BY p.agent_id, p.server, p.skill_uri`)
    : rows(`${base} AND p.agent_id = ? ORDER BY p.server, p.skill_uri`, agentId);
}

/** Active pins whose server is still registered (enabled or not): what a plugin generation holds. */
export function listGeneratedMcpSkillPins(): McpSkillPinRecord[] {
  return rows(
    `SELECT p.* FROM mcp_skill_pins p JOIN mcp_servers s ON s.name = p.server
      WHERE p.state = 'active' ORDER BY p.agent_id, p.server, p.skill_uri`,
  );
}

export interface UpsertMcpSkillPinInput {
  agentId: string;
  server: string;
  skillUri: string;
  skillId: string;
  skillName: string;
  description: string;
  manifest: McpSkillManifest;
  manifestDigest: string;
  libraryRef: string | null;
  externalAllowed: boolean;
  approvedBy: string | null;
  now?: number;
}

/** Write (or re-approve) a pin: it becomes `active` on this manifest. Returns whether the row is new. */
export function upsertMcpSkillPin(input: UpsertMcpSkillPinInput): { created: boolean; pin: McpSkillPinRecord } {
  const now = input.now ?? Date.now();
  const db = getDb();
  let created = false;
  db.transaction(() => {
    created = !getMcpSkillPin(input.agentId, input.server, input.skillUri);
    db.prepare(
      `INSERT INTO mcp_skill_pins
         (agent_id, server, skill_uri, skill_id, skill_name, description, manifest_json, manifest_digest,
          library_ref, external_allowed, state, stale_reason, approved_by, approved_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?)
       ON CONFLICT(agent_id, server, skill_uri) DO UPDATE SET
         skill_id = excluded.skill_id,
         skill_name = excluded.skill_name,
         description = excluded.description,
         manifest_json = excluded.manifest_json,
         manifest_digest = excluded.manifest_digest,
         library_ref = excluded.library_ref,
         external_allowed = excluded.external_allowed,
         state = 'active',
         stale_reason = NULL,
         approved_by = excluded.approved_by,
         approved_at = excluded.approved_at,
         updated_at = excluded.updated_at`,
    ).run(
      input.agentId,
      input.server,
      input.skillUri,
      input.skillId,
      input.skillName,
      input.description,
      JSON.stringify(input.manifest),
      input.manifestDigest,
      input.libraryRef,
      input.externalAllowed ? 1 : 0,
      input.approvedBy,
      now,
      now,
    );
  })();
  const pin = getMcpSkillPin(input.agentId, input.server, input.skillUri);
  if (!pin) throw new Error("The MCP skill pin could not be read back after it was written.");
  return { created, pin };
}

/**
 * Mark the active pins of one skill stale (every agent's, or one agent's),
 * when the server's manifest no longer matches the approved digest. Returns
 * the pins that changed.
 */
export function markMcpSkillPinsStale(input: {
  server: string;
  skillUri: string;
  reason: McpSkillStaleReason;
  /** Only pins approved on another digest (a listing's current digest); omitted: every active pin. */
  unlessDigest?: string;
  agentId?: string;
  now?: number;
}): McpSkillPinRecord[] {
  const now = input.now ?? Date.now();
  const candidates = listMcpSkillPins({
    server: input.server,
    state: "active",
    ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
  }).filter(
    (pin) =>
      pin.skillUri === input.skillUri &&
      (input.unlessDigest === undefined || pin.manifestDigest !== input.unlessDigest),
  );
  const update = getDb().prepare(
    `UPDATE mcp_skill_pins SET state = 'stale', stale_reason = ?, updated_at = ?
      WHERE agent_id = ? AND server = ? AND skill_uri = ? AND state = 'active' AND manifest_digest = ?`,
  );
  const changed: McpSkillPinRecord[] = [];
  for (const pin of candidates) {
    const result = update.run(input.reason, now, pin.agentId, pin.server, pin.skillUri, pin.manifestDigest);
    if (result.changes > 0) changed.push({ ...pin, state: "stale", staleReason: input.reason, updatedAt: now });
  }
  return changed;
}

/**
 * A server lists a skill again: its pins that are stale only because the
 * skill was `gone` become `active` when the listed manifest has exactly the
 * approved digest (what the operator approved); on any other digest they are
 * stale `manifest_changed` (or `dynamic`), which only a new pin clears.
 * Returns the pins that changed and how.
 */
export function settleGoneMcpSkillPins(input: {
  server: string;
  skillUri: string;
  /** The listed manifest's digest, or null for a dynamic file list. */
  listedDigest: string | null;
  now?: number;
}): Array<{ pin: McpSkillPinRecord; change: "restored" | "manifest_changed" | "dynamic" }> {
  const now = input.now ?? Date.now();
  const gone = listMcpSkillPins({ server: input.server, state: "stale" }).filter(
    (pin) => pin.skillUri === input.skillUri && pin.staleReason === "gone",
  );
  const db = getDb();
  const restore = db.prepare(
    `UPDATE mcp_skill_pins SET state = 'active', stale_reason = NULL, updated_at = ?
      WHERE agent_id = ? AND server = ? AND skill_uri = ? AND state = 'stale' AND stale_reason = 'gone'
        AND manifest_digest = ?`,
  );
  const retag = db.prepare(
    `UPDATE mcp_skill_pins SET stale_reason = ?, updated_at = ?
      WHERE agent_id = ? AND server = ? AND skill_uri = ? AND state = 'stale' AND stale_reason = 'gone'
        AND manifest_digest = ?`,
  );
  const changed: Array<{ pin: McpSkillPinRecord; change: "restored" | "manifest_changed" | "dynamic" }> = [];
  for (const pin of gone) {
    if (input.listedDigest !== null && pin.manifestDigest === input.listedDigest) {
      const result = restore.run(now, pin.agentId, pin.server, pin.skillUri, pin.manifestDigest);
      if (result.changes > 0) {
        changed.push({ pin: { ...pin, state: "active", staleReason: null, updatedAt: now }, change: "restored" });
      }
      continue;
    }
    const reason = input.listedDigest === null ? "dynamic" : "manifest_changed";
    const result = retag.run(reason, now, pin.agentId, pin.server, pin.skillUri, pin.manifestDigest);
    if (result.changes > 0) changed.push({ pin: { ...pin, staleReason: reason, updatedAt: now }, change: reason });
  }
  return changed;
}

/** Remove one pin. Returns whether a row went. */
export function deleteMcpSkillPin(agentId: string, server: string, skillUri: string): boolean {
  return (
    getDb()
      .prepare("DELETE FROM mcp_skill_pins WHERE agent_id = ? AND server = ? AND skill_uri = ?")
      .run(agentId, server, skillUri).changes > 0
  );
}

/** Drop the pins of a server (all agents, or one agent: detach). Returns how many went. */
export function deleteMcpSkillPinsForServer(server: string, agentId?: string): number {
  const db = getDb();
  return agentId === undefined
    ? db.prepare("DELETE FROM mcp_skill_pins WHERE server = ?").run(server).changes
    : db.prepare("DELETE FROM mcp_skill_pins WHERE server = ? AND agent_id = ?").run(server, agentId).changes;
}
