import { randomUUID } from "node:crypto";
import { getDb, getRaviDbPath } from "../router/router-db.js";
import { dbGetTagDefinition } from "../tags/tag-db.js";
import { assertBreakGlassStoreWrite, slugBreakGlassReasons } from "./break-glass.js";

/**
 * Provider-owned storage for chat-scoped contact permission grants.
 *
 * A row links one contact to one permission profile (a provider-owned
 * `permission-*` tag definition) inside one scope: a canonical chat id or a
 * chat tag slug. Capabilities are resolved from the profile at materialization
 * time, so editing the profile updates every grant that references it.
 *
 * Only `contact-policy-permissions` consumes this table. It is not a generic
 * relation graph.
 */

export type ContactChatGrantScopeType = "chat" | "chat_tag";

export interface ContactChatGrant {
  id: string;
  contactId: string;
  profileSlug: string;
  scopeType: ContactChatGrantScopeType;
  scopeId: string;
  createdBy?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ContactChatGrantKey {
  contactId: string;
  profileSlug: string;
  scopeType: ContactChatGrantScopeType;
  scopeId: string;
}

export interface ContactChatGrantQuery {
  contactId?: string;
  profileSlug?: string;
  scopeType?: ContactChatGrantScopeType;
  scopeId?: string;
}

interface ContactChatGrantRow {
  id: string;
  contact_id: string;
  profile_slug: string;
  scope_type: ContactChatGrantScopeType;
  scope_id: string;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

let schemaDbPath: string | null = null;

export function ensureContactChatGrantSchema(): void {
  const dbPath = getRaviDbPath();
  if (schemaDbPath === dbPath) return;
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS permission_contact_chat_grants (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL,
      profile_slug TEXT NOT NULL,
      scope_type TEXT NOT NULL CHECK (scope_type IN ('chat', 'chat_tag')),
      scope_id TEXT NOT NULL,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(contact_id, profile_slug, scope_type, scope_id)
    );

    CREATE INDEX IF NOT EXISTS idx_permission_contact_chat_grants_scope
      ON permission_contact_chat_grants(scope_type, scope_id);
    CREATE INDEX IF NOT EXISTS idx_permission_contact_chat_grants_contact
      ON permission_contact_chat_grants(contact_id, scope_type, scope_id);
  `);
  schemaDbPath = dbPath;
}

export function dbGetContactChatGrant(key: ContactChatGrantKey): ContactChatGrant | null {
  ensureContactChatGrantSchema();
  const row = getDb()
    .prepare(
      `SELECT * FROM permission_contact_chat_grants
        WHERE contact_id = ? AND profile_slug = ? AND scope_type = ? AND scope_id = ?`,
    )
    .get(key.contactId, key.profileSlug, key.scopeType, key.scopeId) as ContactChatGrantRow | undefined;
  return row ? rowToGrant(row) : null;
}

export function dbEnsureContactChatGrant(key: ContactChatGrantKey & { createdBy?: string }): {
  grant: ContactChatGrant;
  created: boolean;
} {
  const existing = dbGetContactChatGrant(key);
  if (existing) return { grant: existing, created: false };
  // Sink guard (spec permissions/break-glass): a new grant whose profile carries
  // break-glass is refused for an agent turn, whatever wrote it.
  assertBreakGlassStoreWrite(
    `chat grant ${key.profileSlug} for contact:${key.contactId}`,
    slugBreakGlassReasons(key.profileSlug, dbGetTagDefinition),
  );
  const now = Date.now();
  const id = `pcg_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  getDb()
    .prepare(
      `INSERT INTO permission_contact_chat_grants (
        id, contact_id, profile_slug, scope_type, scope_id, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, key.contactId, key.profileSlug, key.scopeType, key.scopeId, key.createdBy ?? null, now, now);
  const grant = dbGetContactChatGrant(key);
  if (!grant) throw new Error("Failed to persist contact chat grant.");
  return { grant, created: true };
}

export function dbDeleteContactChatGrant(key: ContactChatGrantKey): boolean {
  ensureContactChatGrantSchema();
  const result = getDb()
    .prepare(
      `DELETE FROM permission_contact_chat_grants
        WHERE contact_id = ? AND profile_slug = ? AND scope_type = ? AND scope_id = ?`,
    )
    .run(key.contactId, key.profileSlug, key.scopeType, key.scopeId);
  return result.changes > 0;
}

export function dbListContactChatGrants(query: ContactChatGrantQuery = {}): ContactChatGrant[] {
  ensureContactChatGrantSchema();
  const where: string[] = [];
  const params: string[] = [];
  if (query.contactId) {
    where.push("contact_id = ?");
    params.push(query.contactId);
  }
  if (query.profileSlug) {
    where.push("profile_slug = ?");
    params.push(query.profileSlug);
  }
  if (query.scopeType) {
    where.push("scope_type = ?");
    params.push(query.scopeType);
  }
  if (query.scopeId) {
    where.push("scope_id = ?");
    params.push(query.scopeId);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(
      `SELECT * FROM permission_contact_chat_grants ${clause}
        ORDER BY contact_id, scope_type, scope_id, profile_slug`,
    )
    .all(...params) as ContactChatGrantRow[];
  return rows.map(rowToGrant);
}

/**
 * Grants whose scope covers a chat: direct grants on the chat id plus grants on
 * any tag the chat carries.
 */
export function dbListContactChatGrantsCoveringChat(input: {
  chatId: string;
  chatTags: readonly string[];
  contactId?: string;
}): ContactChatGrant[] {
  ensureContactChatGrantSchema();
  const scopeClauses = ["(scope_type = 'chat' AND scope_id = ?)"];
  const params: string[] = [input.chatId];
  if (input.chatTags.length > 0) {
    scopeClauses.push(`(scope_type = 'chat_tag' AND scope_id IN (${input.chatTags.map(() => "?").join(", ")}))`);
    params.push(...input.chatTags);
  }
  let clause = `(${scopeClauses.join(" OR ")})`;
  if (input.contactId) {
    clause += " AND contact_id = ?";
    params.push(input.contactId);
  }
  const rows = getDb()
    .prepare(
      `SELECT * FROM permission_contact_chat_grants WHERE ${clause}
        ORDER BY contact_id, scope_type, scope_id, profile_slug`,
    )
    .all(...params) as ContactChatGrantRow[];
  return rows.map(rowToGrant);
}

function rowToGrant(row: ContactChatGrantRow): ContactChatGrant {
  return {
    id: row.id,
    contactId: row.contact_id,
    profileSlug: row.profile_slug,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    ...(row.created_by ? { createdBy: row.created_by } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
