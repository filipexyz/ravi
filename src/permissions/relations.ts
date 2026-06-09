/**
 * REBAC — Relation Store
 *
 * CRUD operations for the relations table.
 * Relations represent permissions: (subject) has (relation) on (object).
 *
 * Examples:
 *   (agent, main, admin, system, *)         — main is superadmin
 *   (agent, dev, can_execute, group, contacts) — dev can run contacts commands
 *   (agent, dev, access, session, dev-*)    — dev can access sessions matching dev-*
 */

import { getDb, dbListAgents } from "../router/router-db.js";
import { executeWrite } from "../db/write-retry.js";
import { logger } from "../utils/logger.js";
import { resolvePermissionDenialsForGrant } from "./denials.js";
const log = logger.child("permissions:relations");

// ============================================================================
// Types
// ============================================================================

export type GrantMode = "temporary" | "permanent";

export const DEFAULT_MANUAL_GRANT_TTL_MS = 60 * 60 * 1000;

export interface Relation {
  id: number;
  subjectType: string;
  subjectId: string;
  relation: string;
  objectType: string;
  objectId: string;
  source: string;
  grantMode: GrantMode;
  expiresAt: number | null;
  revokedAt: number | null;
  reason: string | null;
  issuedBy: string | null;
  createdAt: number;
}

interface RelationRow {
  id: number;
  subject_type: string;
  subject_id: string;
  relation: string;
  object_type: string;
  object_id: string;
  source: string;
  grant_mode?: string | null;
  expires_at?: number | null;
  revoked_at?: number | null;
  reason?: string | null;
  issued_by?: string | null;
  created_at: number;
}

export interface RelationFilter {
  subjectType?: string;
  subjectId?: string;
  relation?: string;
  objectType?: string;
  objectId?: string;
  source?: string;
  includeInactive?: boolean;
}

export interface GrantRelationOptions {
  ttlMs?: number | null;
  expiresAt?: number | null;
  permanent?: boolean;
  reason?: string | null;
  issuedBy?: string | null;
}

// ============================================================================
// Row Mapping
// ============================================================================

function rowToRelation(row: RelationRow): Relation {
  const grantMode = row.grant_mode === "temporary" ? "temporary" : "permanent";
  return {
    id: row.id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    relation: row.relation,
    objectType: row.object_type,
    objectId: row.object_id,
    source: row.source,
    grantMode,
    expiresAt: typeof row.expires_at === "number" ? row.expires_at : null,
    revokedAt: typeof row.revoked_at === "number" ? row.revoked_at : null,
    reason: row.reason ?? null,
    issuedBy: row.issued_by ?? null,
    createdAt: row.created_at,
  };
}

// ============================================================================
// CRUD Operations
// ============================================================================

/**
 * Validate that a wildcard pattern uses only trailing wildcards.
 * e.g., "dev-*" is valid, "*" is valid, "dev*grupo" is invalid, "*-dev" is invalid.
 */
function validateWildcard(objectId: string): void {
  if (objectId.includes("*") && objectId !== "*" && !objectId.endsWith("*")) {
    throw new Error(`Invalid wildcard pattern: "${objectId}". Only trailing wildcards are supported (e.g., "dev-*").`);
  }
  // Also reject multiple wildcards like "a*b*"
  const starCount = (objectId.match(/\*/g) || []).length;
  if (starCount > 1) {
    throw new Error(`Invalid wildcard pattern: "${objectId}". Only a single trailing wildcard is supported.`);
  }
}

function activeRelationWhere(): string {
  return "(revoked_at IS NULL AND (expires_at IS NULL OR expires_at > unixepoch()))";
}

function resolveGrantMetadata(
  source: string,
  options: GrantRelationOptions,
  now: number,
): {
  grantMode: GrantMode;
  expiresAt: number | null;
  reason: string | null;
  issuedBy: string | null;
} {
  const reason = normalizeOptionalString(options.reason);
  const issuedBy = normalizeOptionalString(options.issuedBy);

  if (options.permanent === true) {
    return { grantMode: "permanent", expiresAt: null, reason, issuedBy };
  }

  if (typeof options.expiresAt === "number") {
    return {
      grantMode: "temporary",
      expiresAt: Math.floor(options.expiresAt),
      reason,
      issuedBy,
    };
  }

  if (typeof options.ttlMs === "number") {
    const ttlSeconds = Math.max(0, Math.ceil(options.ttlMs / 1000));
    return {
      grantMode: "temporary",
      expiresAt: now + ttlSeconds,
      reason,
      issuedBy,
    };
  }

  if (source === "manual") {
    return {
      grantMode: "temporary",
      expiresAt: now + Math.ceil(DEFAULT_MANUAL_GRANT_TTL_MS / 1000),
      reason,
      issuedBy,
    };
  }

  return { grantMode: "permanent", expiresAt: null, reason, issuedBy };
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isActiveRelation(relation: Relation): boolean {
  if (relation.revokedAt) return false;
  return !relation.expiresAt || relation.expiresAt > Math.floor(Date.now() / 1000);
}

/**
 * Grant a relation. Upsert — if the exact tuple already exists, it's a no-op.
 */
export function grantRelation(
  subjectType: string,
  subjectId: string,
  relation: string,
  objectType: string,
  objectId: string,
  source: string = "manual",
  options: GrantRelationOptions = {},
): Relation | null {
  validateWildcard(objectId);
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const metadata = resolveGrantMetadata(source, options, now);
  db.prepare(
    `
    INSERT INTO relations (
      subject_type,
      subject_id,
      relation,
      object_type,
      object_id,
      source,
      grant_mode,
      expires_at,
      revoked_at,
      reason,
      issued_by,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
    ON CONFLICT(subject_type, subject_id, relation, object_type, object_id) DO UPDATE SET
      source = excluded.source,
      grant_mode = excluded.grant_mode,
      expires_at = excluded.expires_at,
      revoked_at = NULL,
      reason = excluded.reason,
      issued_by = excluded.issued_by,
      created_at = excluded.created_at
  `,
  ).run(
    subjectType,
    subjectId,
    relation,
    objectType,
    objectId,
    source,
    metadata.grantMode,
    metadata.expiresAt,
    metadata.reason,
    metadata.issuedBy,
    now,
  );

  const granted =
    listRelations({
      subjectType,
      subjectId,
      relation,
      objectType,
      objectId,
      includeInactive: true,
    })[0] ?? null;

  if (source === "manual" && granted && isActiveRelation(granted)) {
    resolvePermissionDenialsForGrant(granted);
  }

  return granted;
}

/**
 * Revoke a specific relation.
 */
export function revokeRelation(
  subjectType: string,
  subjectId: string,
  relation: string,
  objectType: string,
  objectId: string,
): boolean {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const result = db
    .prepare(
      `
    UPDATE relations
    SET revoked_at = ?
    WHERE subject_type = ? AND subject_id = ? AND relation = ? AND object_type = ? AND object_id = ?
  `,
    )
    .run(now, subjectType, subjectId, relation, objectType, objectId);
  return result.changes > 0;
}

/**
 * Check if a specific relation exists (exact match, no wildcard resolution).
 */
export function hasRelation(
  subjectType: string,
  subjectId: string,
  relation: string,
  objectType: string,
  objectId: string,
): boolean {
  const db = getDb();
  const row = db
    .prepare(
      `
    SELECT 1 FROM relations
    WHERE subject_type = ? AND subject_id = ? AND relation = ? AND object_type = ? AND object_id = ?
      AND ${activeRelationWhere()}
    LIMIT 1
  `,
    )
    .get(subjectType, subjectId, relation, objectType, objectId);
  return row !== null && row !== undefined;
}

/**
 * List relations with optional filtering.
 */
export function listRelations(filter?: RelationFilter): Relation[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: string[] = [];

  if (!filter?.includeInactive) {
    conditions.push(activeRelationWhere());
  }
  if (filter?.subjectType) {
    conditions.push("subject_type = ?");
    params.push(filter.subjectType);
  }
  if (filter?.subjectId) {
    conditions.push("subject_id = ?");
    params.push(filter.subjectId);
  }
  if (filter?.relation) {
    conditions.push("relation = ?");
    params.push(filter.relation);
  }
  if (filter?.objectType) {
    conditions.push("object_type = ?");
    params.push(filter.objectType);
  }
  if (filter?.objectId) {
    conditions.push("object_id = ?");
    params.push(filter.objectId);
  }
  if (filter?.source) {
    conditions.push("source = ?");
    params.push(filter.source);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db.prepare(`SELECT * FROM relations ${where} ORDER BY id`).all(...params) as RelationRow[];
  return rows.map(rowToRelation);
}

/**
 * Clear relations. Optionally filter by subject and/or source.
 */
export function clearRelations(opts?: { subjectType?: string; subjectId?: string; source?: string }): number {
  const db = getDb();
  const conditions: string[] = [];
  const params: string[] = [];

  if (opts?.subjectType) {
    conditions.push("subject_type = ?");
    params.push(opts.subjectType);
  }
  if (opts?.subjectId) {
    conditions.push("subject_id = ?");
    params.push(opts.subjectId);
  }
  if (opts?.source) {
    conditions.push("source = ?");
    params.push(opts.source);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = db.prepare(`DELETE FROM relations ${where}`).run(...params);
  return result.changes;
}

// ============================================================================
// Config Sync
// ============================================================================

/**
 * Sync relations from agent configs.
 *
 * Reads all agents and generates relations with source='config'.
 * Manual relations (source='manual') are preserved.
 *
 * Called on daemon boot to keep relations in sync with agent configuration.
 */
export function syncRelationsFromConfig(): void {
  const db = getDb();
  const agents = dbListAgents();
  let granted = 0;

  // Atomic: clear + re-grant in a single transaction (no permission gap)
  executeWrite(
    db,
    () => {
      const cleared = clearRelations({ source: "config" });
      if (cleared > 0) {
        log.debug("Cleared config relations", { count: cleared });
      }

      for (const agent of agents) {
        // Main agent = superadmin
        if (agent.id === "main") {
          grantRelation("agent", agent.id, "admin", "system", "*", "config");
          granted++;
          continue;
        }

        // contactScope → write/read permissions
        if (agent.contactScope === "all") {
          grantRelation("agent", agent.id, "write_contacts", "system", "*", "config");
          granted++;
        } else if (agent.contactScope === "own") {
          grantRelation("agent", agent.id, "read_own_contacts", "system", "*", "config");
          granted++;
        } else if (agent.contactScope?.startsWith("tagged:")) {
          const tag = agent.contactScope.slice(7);
          grantRelation("agent", agent.id, "read_tagged_contacts", "system", tag, "config");
          granted++;
        }

        // allowedSessions → session access
        if (agent.allowedSessions) {
          for (const pattern of agent.allowedSessions) {
            grantRelation("agent", agent.id, "access", "session", pattern, "config");
            granted++;
          }
        }
      }
    },
    { label: "permissions:syncFromConfig" },
  );

  log.info("Synced relations from config", { agents: agents.length, granted });
}
