import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { getRaviStateDir } from "./utils/paths.js";

// Re-export normalize functions for backwards compatibility
export {
  normalizePhone,
  isGroup,
  formatPhone,
} from "./utils/phone.js";

import { normalizePhone } from "./utils/phone.js";

function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getRaviStateDir(env), "chat.db");
}

let db: Database | null = null;
let dbPath: string | null = null;
let stmts: ReturnType<typeof createStatements> | null = null;

const IDENTITY_PROJECTION_BACKFILL_KEY = "identity_projection_backfill_v1";

function ensureDb(): Database {
  const nextDbPath = resolveDbPath();
  if (db !== null && dbPath === nextDbPath && stmts !== null) {
    return db;
  }

  if (db !== null) {
    db.close();
  }

  mkdirSync(getRaviStateDir(), { recursive: true });

  const database = new Database(nextDbPath);

  // WAL mode for concurrent read/write access (CLI + daemon)
  database.exec("PRAGMA journal_mode = WAL");
  // Wait up to 5s for locks to clear instead of failing immediately
  database.exec("PRAGMA busy_timeout = 5000");
  // Enable foreign keys
  database.exec("PRAGMA foreign_keys = ON");

  initializeSchema(database);
  migrateFromV1(database);
  ensureAllowedAgentsColumn(database);
  initializeIdentitySchema(database);
  ensureIdentityProjection(database);

  db = database;
  dbPath = nextDbPath;
  stmts = createStatements(database);
  return database;
}

function getStatements(): ReturnType<typeof createStatements> {
  ensureDb();
  return stmts!;
}

// ============================================================================
// Schema v2: contacts_v2 + contact_identities
// ============================================================================

function initializeSchema(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS contacts_v2 (
      id TEXT PRIMARY KEY,
      name TEXT,
      email TEXT,
      status TEXT DEFAULT 'allowed' CHECK(status IN ('allowed', 'pending', 'blocked', 'discovered')),
      agent_id TEXT,
      reply_mode TEXT DEFAULT 'auto',
      tags TEXT,
      notes TEXT,
      opt_out INTEGER DEFAULT 0,
      source TEXT,
      last_inbound_at TEXT,
      last_outbound_at TEXT,
      interaction_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS contact_identities (
      contact_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      identity_value TEXT NOT NULL,
      is_primary INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (platform, identity_value),
      FOREIGN KEY (contact_id) REFERENCES contacts_v2(id) ON DELETE CASCADE
    );
  `);

  // Index for looking up all identities of a contact
  try {
    database.exec(`CREATE INDEX IF NOT EXISTS idx_identities_contact ON contact_identities(contact_id)`);
  } catch {
    /* exists */
  }

  // Per-account pending: tracks contacts that messaged an account without a matching route
  database.exec(`
    CREATE TABLE IF NOT EXISTS account_pending (
      account_id TEXT NOT NULL,
      phone TEXT NOT NULL,
      name TEXT,
      chat_id TEXT,
      is_group INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, phone)
    );
  `);
}

// ============================================================================
// Migration from old contacts table
// ============================================================================

function migrateFromV1(database: Database): void {
  const serializeLegacyField = (value: unknown): string | null => {
    if (value === null || value === undefined) return null;
    return typeof value === "string" ? value : JSON.stringify(value);
  };

  // Check if old table exists
  const oldTable = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='contacts'").get() as
    | { name: string }
    | undefined;

  if (!oldTable) return;

  const oldColumns = database.prepare("PRAGMA table_info(contacts)").all() as Array<{ name: string }>;
  const looksLikeLegacyContacts = oldColumns.some((c) => c.name === "phone");
  if (!looksLikeLegacyContacts) return;

  // Check if already migrated (contacts_legacy exists)
  const legacyTable = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='contacts_legacy'")
    .get() as { name: string } | undefined;

  if (legacyTable) return;

  // Check if v2 already has data (skip migration)
  const v2Count = (database.prepare("SELECT COUNT(*) as c FROM contacts_v2").get() as { c: number }).c;
  if (v2Count > 0) {
    // Already has v2 data, just rename old table
    database.exec("ALTER TABLE contacts RENAME TO contacts_legacy");
    return;
  }

  // Migrate each row
  const rows = database.prepare("SELECT * FROM contacts").all() as Array<Record<string, unknown>>;

  const insertContact = database.prepare(`
    INSERT INTO contacts_v2 (id, name, email, status, agent_id, reply_mode, tags, notes, opt_out, source, last_inbound_at, last_outbound_at, interaction_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertIdentity = database.prepare(`
    INSERT INTO contact_identities (contact_id, platform, identity_value, is_primary)
    VALUES (?, ?, ?, 1)
  `);

  const txn = database.transaction(() => {
    for (const row of rows) {
      const phone = row.phone as string;
      const id = generateId();

      // Detect platform from phone format
      let platform: string;
      if (phone.startsWith("lid:")) {
        platform = "whatsapp_lid";
      } else if (phone.startsWith("group:")) {
        platform = "whatsapp_group";
      } else {
        platform = "phone";
      }

      insertContact.run(
        id,
        serializeLegacyField(row.name),
        serializeLegacyField(row.email),
        serializeLegacyField(row.status) ?? "allowed",
        serializeLegacyField(row.agent_id),
        serializeLegacyField(row.reply_mode) ?? "auto",
        serializeLegacyField(row.tags),
        serializeLegacyField(row.notes),
        typeof row.opt_out === "number" ? row.opt_out : 0,
        serializeLegacyField(row.source),
        serializeLegacyField(row.last_inbound_at),
        serializeLegacyField(row.last_outbound_at),
        typeof row.interaction_count === "number" ? row.interaction_count : 0,
        serializeLegacyField(row.created_at),
        serializeLegacyField(row.updated_at),
      );

      insertIdentity.run(id, platform, phone);
    }

    // Rename old table as backup
    database.exec("ALTER TABLE contacts RENAME TO contacts_legacy");
  });

  txn();
}

function ensureAllowedAgentsColumn(database: Database): void {
  const contactCols = database.prepare("PRAGMA table_info(contacts_v2)").all() as Array<{ name: string }>;
  if (!contactCols.some((c) => c.name === "allowed_agents")) {
    database.exec("ALTER TABLE contacts_v2 ADD COLUMN allowed_agents TEXT");
  }
}

// ============================================================================
// Identity graph schema: canonical contacts + platform identities
// ============================================================================

function initializeIdentitySchema(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'person' CHECK(kind IN ('person', 'org')),
      display_name TEXT,
      primary_phone TEXT,
      primary_email TEXT,
      avatar_url TEXT,
      metadata_json TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS platform_identities (
      id TEXT PRIMARY KEY,
      owner_type TEXT CHECK(owner_type IS NULL OR owner_type IN ('contact', 'agent')),
      owner_id TEXT,
      channel TEXT NOT NULL,
      instance_id TEXT NOT NULL DEFAULT '',
      platform_user_id TEXT NOT NULL,
      normalized_platform_user_id TEXT NOT NULL,
      platform_display_name TEXT,
      avatar_url TEXT,
      profile_data_json TEXT,
      is_primary INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0, 1)),
      confidence REAL NOT NULL DEFAULT 1.0,
      linked_by TEXT,
      link_reason TEXT,
      first_seen_at TEXT DEFAULT (datetime('now')),
      last_seen_at TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      CHECK((owner_type IS NULL AND owner_id IS NULL) OR (owner_type IS NOT NULL AND owner_id IS NOT NULL))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_identities_unique
      ON platform_identities(channel, instance_id, normalized_platform_user_id);
    CREATE INDEX IF NOT EXISTS idx_platform_identities_owner
      ON platform_identities(owner_type, owner_id);

    CREATE TABLE IF NOT EXISTS contact_policies (
      contact_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'allowed' CHECK(status IN ('allowed', 'pending', 'blocked', 'discovered')),
      reply_mode TEXT NOT NULL DEFAULT 'auto' CHECK(reply_mode IN ('auto', 'mention')),
      allowed_agents_json TEXT,
      opt_out INTEGER NOT NULL DEFAULT 0 CHECK(opt_out IN (0, 1)),
      tags_json TEXT,
      notes_json TEXT,
      source TEXT,
      last_inbound_at TEXT,
      last_outbound_at TEXT,
      interaction_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS identity_link_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL CHECK(event_type IN ('link', 'unlink', 'merge', 'split', 'auto_link', 'candidate')),
      source_owner_type TEXT,
      source_owner_id TEXT,
      target_owner_type TEXT,
      target_owner_id TEXT,
      platform_identity_id TEXT,
      confidence REAL,
      reason TEXT,
      actor_type TEXT,
      actor_id TEXT,
      metadata_json TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_identity_link_events_identity
      ON identity_link_events(platform_identity_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_identity_link_events_target
      ON identity_link_events(target_owner_type, target_owner_id, created_at);

    CREATE TABLE IF NOT EXISTS contacts_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

function stableId(prefix: string, parts: Array<string | null | undefined>): string {
  const hash = createHash("sha256")
    .update(parts.map((part) => part ?? "").join("\x1f"))
    .digest("hex")
    .slice(0, 24);
  return `${prefix}_${hash}`;
}

function parseJsonArray(value: string | null): unknown[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseJsonValue(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function legacyIdentityIsGroup(platform: string, value: string): boolean {
  return platform === "whatsapp_group" || normalizePhone(value).startsWith("group:");
}

function isLegacyGroupOnlyContact(contact: Contact): boolean {
  return (
    contact.identities.length > 0 &&
    contact.identities.every((identity) => legacyIdentityIsGroup(identity.platform, identity.value))
  );
}

function legacyProjectionContactIds(database: Database): Set<string> {
  const rows = database
    .prepare(
      `
      SELECT c.id, ci.platform, ci.identity_value
      FROM contacts_v2 c
      LEFT JOIN contact_identities ci ON ci.contact_id = c.id
    `,
    )
    .all() as Array<{ id: string; platform: string | null; identity_value: string | null }>;

  const grouped = new Map<string, Array<{ platform: string; value: string }>>();
  for (const row of rows) {
    const entries = grouped.get(row.id) ?? [];
    if (row.platform && row.identity_value) entries.push({ platform: row.platform, value: row.identity_value });
    grouped.set(row.id, entries);
  }

  const expected = new Set<string>();
  for (const [contactId, identities] of grouped) {
    if (
      identities.length === 0 ||
      identities.some((identity) => !legacyIdentityIsGroup(identity.platform, identity.value))
    ) {
      expected.add(contactId);
    }
  }
  return expected;
}

function identityProjectionSourceFingerprint(database: Database): string {
  const contacts = database
    .prepare("SELECT COUNT(*) AS count, COALESCE(MAX(updated_at), '') AS maxUpdatedAt FROM contacts_v2")
    .get() as { count: number; maxUpdatedAt: string };
  const identities = database
    .prepare("SELECT COUNT(*) AS count, COALESCE(MAX(created_at), '') AS maxCreatedAt FROM contact_identities")
    .get() as { count: number; maxCreatedAt: string };
  return JSON.stringify({
    contactsCount: contacts.count,
    contactsMaxUpdatedAt: contacts.maxUpdatedAt,
    identitiesCount: identities.count,
    identitiesMaxCreatedAt: identities.maxCreatedAt,
  });
}

function getStoredIdentityProjectionFingerprint(database: Database): string | null {
  const row = database.prepare("SELECT value FROM contacts_meta WHERE key = ?").get(IDENTITY_PROJECTION_BACKFILL_KEY) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function markIdentityProjectionCurrent(
  database: Database,
  fingerprint = identityProjectionSourceFingerprint(database),
): void {
  database
    .prepare(
      `
      INSERT INTO contacts_meta (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `,
    )
    .run(IDENTITY_PROJECTION_BACKFILL_KEY, fingerprint);
}

function identityProjectionLooksComplete(database: Database): boolean {
  const expectedIds = legacyProjectionContactIds(database);
  if (expectedIds.size === 0) return true;

  const canonicalRows = database.prepare("SELECT id FROM contacts").all() as Array<{ id: string }>;
  const canonicalIds = new Set(canonicalRows.map((row) => row.id));
  for (const contactId of expectedIds) {
    if (!canonicalIds.has(contactId)) return false;
  }

  const policyRows = database.prepare("SELECT contact_id FROM contact_policies").all() as Array<{ contact_id: string }>;
  const policyIds = new Set(policyRows.map((row) => row.contact_id));
  for (const contactId of expectedIds) {
    if (!policyIds.has(contactId)) return false;
  }

  return true;
}

function contactProjectionIsCurrent(database: Database, contact: Contact): boolean {
  const canonical = database.prepare("SELECT updated_at FROM contacts WHERE id = ?").get(contact.id) as
    | { updated_at: string | null }
    | undefined;
  if (!canonical) return false;

  const policy = database.prepare("SELECT updated_at FROM contact_policies WHERE contact_id = ?").get(contact.id) as
    | { updated_at: string | null }
    | undefined;
  if (!policy) return false;

  const legacyUpdatedAt = contact.updated_at ?? "";
  return (canonical.updated_at ?? "") >= legacyUpdatedAt && (policy.updated_at ?? "") >= legacyUpdatedAt;
}

function assertPersonOrOrgIdentity(value: string, operation: string): string {
  const normalized = normalizePhone(value);
  if (normalized.startsWith("group:")) {
    throw new Error(`${operation} expects a person/org identity. Groups and chats belong to chat review.`);
  }
  return normalized;
}

function normalizeIdentityForChannel(channel: string, value: string): string {
  const trimmed = value.trim();
  if (channel === "phone" || channel === "whatsapp") return normalizePhone(trimmed);
  if (channel === "email") return trimmed.toLowerCase();
  return trimmed;
}

function normalizePlatformIdentityChannel(channel: string): string {
  return channel
    .trim()
    .toLowerCase()
    .replace(/-baileys$/, "");
}

function normalizeLegacyIdentityValue(platform: string, value: string): string {
  if (platform === "email") return normalizeIdentityForChannel("email", value);
  if (platform === "telegram" || platform === "matrix") return value.trim();
  return normalizePhone(value);
}

function mapLegacyPlatform(platform: string, value: string): { channel: string; normalizedValue: string } | null {
  if (legacyIdentityIsGroup(platform, value)) return null;

  const channel =
    platform === "phone"
      ? "phone"
      : platform === "whatsapp_lid"
        ? "whatsapp"
        : platform === "telegram"
          ? "telegram"
          : platform === "email"
            ? "email"
            : platform;

  return {
    channel,
    normalizedValue: normalizeIdentityForChannel(channel, value),
  };
}

function metadataJson(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function deleteContactProjection(database: Database, contactId: string): void {
  database.prepare("DELETE FROM platform_identities WHERE owner_type = 'contact' AND owner_id = ?").run(contactId);
  database.prepare("DELETE FROM contact_policies WHERE contact_id = ?").run(contactId);
  database.prepare("DELETE FROM contacts WHERE id = ?").run(contactId);
}

function moveCanonicalPlatformIdentities(
  database: Database,
  sourceContactId: string,
  targetContactId: string,
): string[] {
  const sourceRows = database
    .prepare("SELECT * FROM platform_identities WHERE owner_type = 'contact' AND owner_id = ?")
    .all(sourceContactId) as PlatformIdentityRow[];
  const moved: string[] = [];

  for (const row of sourceRows) {
    const conflict = database
      .prepare(
        `
        SELECT id FROM platform_identities
        WHERE owner_type = 'contact'
          AND owner_id = ?
          AND channel = ?
          AND instance_id = ?
          AND normalized_platform_user_id = ?
      `,
      )
      .get(targetContactId, row.channel, row.instance_id, row.normalized_platform_user_id) as
      | { id: string }
      | undefined;

    if (conflict) {
      database.prepare("DELETE FROM platform_identities WHERE id = ?").run(row.id);
      continue;
    }

    database
      .prepare("UPDATE platform_identities SET owner_id = ?, updated_at = datetime('now') WHERE id = ?")
      .run(targetContactId, row.id);
    moved.push(row.id);
  }

  return moved;
}

function syncContactProjection(database: Database, contactId: string): void {
  const row = database.prepare("SELECT * FROM contacts_v2 WHERE id = ?").get(contactId) as ContactV2Row | undefined;
  if (!row) {
    deleteContactProjection(database, contactId);
    return;
  }

  const identities = database
    .prepare("SELECT * FROM contact_identities WHERE contact_id = ? ORDER BY is_primary DESC, created_at")
    .all(contactId) as IdentityRow[];
  const nonGroupIdentities = identities.filter(
    (identity) => !legacyIdentityIsGroup(identity.platform, identity.identity_value),
  );
  const mappedIdentities = nonGroupIdentities
    .map((identity) => ({ identity, mapped: mapLegacyPlatform(identity.platform, identity.identity_value) }))
    .filter((entry): entry is { identity: IdentityRow; mapped: { channel: string; normalizedValue: string } } =>
      Boolean(entry.mapped),
    );

  // Legacy group-only contacts remain in contacts_v2 for compatibility until
  // chat/routing flows no longer need group-as-contact. They are intentionally
  // not projected into canonical contacts.
  if (nonGroupIdentities.length === 0 && identities.length > 0) {
    deleteContactProjection(database, contactId);
    return;
  }

  const primaryPhone =
    mappedIdentities.find((entry) => entry.mapped.channel === "phone")?.mapped.normalizedValue ?? null;
  const legacyNotes = parseJsonObject(row.notes);
  const legacyTags = parseJsonArray(row.tags);
  const metadata = {
    legacy: {
      sourceTable: "contacts_v2",
      legacyIdentityPlatforms: identities.map((identity) => identity.platform),
      groupOnlyCompatibility: identities.length > 0 && nonGroupIdentities.length === 0,
    },
  };

  database
    .prepare(
      `
      INSERT INTO contacts (
        id, kind, display_name, primary_phone, primary_email, avatar_url, metadata_json, created_at, updated_at
      )
      VALUES (?, 'person', ?, ?, ?, NULL, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))
      ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        primary_phone = excluded.primary_phone,
        primary_email = excluded.primary_email,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `,
    )
    .run(row.id, row.name, primaryPhone, row.email, metadataJson(metadata), row.created_at, row.updated_at);

  database
    .prepare(
      `
      INSERT INTO contact_policies (
        contact_id, status, reply_mode, allowed_agents_json, opt_out, tags_json, notes_json,
        source, last_inbound_at, last_outbound_at, interaction_count, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))
      ON CONFLICT(contact_id) DO UPDATE SET
        status = excluded.status,
        reply_mode = excluded.reply_mode,
        allowed_agents_json = excluded.allowed_agents_json,
        opt_out = excluded.opt_out,
        tags_json = excluded.tags_json,
        notes_json = excluded.notes_json,
        source = excluded.source,
        last_inbound_at = excluded.last_inbound_at,
        last_outbound_at = excluded.last_outbound_at,
        interaction_count = excluded.interaction_count,
        updated_at = excluded.updated_at
    `,
    )
    .run(
      row.id,
      row.status ?? "allowed",
      row.reply_mode ?? "auto",
      row.allowed_agents,
      row.opt_out ?? 0,
      legacyTags ? JSON.stringify(legacyTags) : row.tags,
      legacyNotes ? JSON.stringify(legacyNotes) : row.notes,
      row.source,
      row.last_inbound_at,
      row.last_outbound_at,
      row.interaction_count ?? 0,
      row.created_at,
      row.updated_at,
    );

  const projectedIdentityKeys = new Set(
    mappedIdentities.map((entry) => `${entry.mapped.channel}\x1f\x1f${entry.mapped.normalizedValue}`),
  );
  const existingCanonicalIdentities = database
    .prepare(
      "SELECT id, channel, instance_id, normalized_platform_user_id, linked_by, link_reason FROM platform_identities WHERE owner_type = 'contact' AND owner_id = ?",
    )
    .all(row.id) as Array<{
    id: string;
    channel: string;
    instance_id: string;
    normalized_platform_user_id: string;
    linked_by: string | null;
    link_reason: string | null;
  }>;
  for (const existing of existingCanonicalIdentities) {
    const key = `${existing.channel}\x1f${existing.instance_id ?? ""}\x1f${existing.normalized_platform_user_id}`;
    const projectionManaged = existing.linked_by === "initial" && existing.link_reason === "legacy_backfill";
    if (!projectedIdentityKeys.has(key) && projectionManaged) {
      database.prepare("DELETE FROM platform_identities WHERE id = ?").run(existing.id);
    }
  }

  for (const { identity, mapped } of mappedIdentities) {
    const platformIdentityId = stableId("pi", ["", mapped.channel, mapped.normalizedValue]);
    const existing = findPlatformIdentityByChannelRef(database, {
      channel: mapped.channel,
      instanceId: "",
      platformUserId: mapped.normalizedValue,
    });
    if (platformIdentityOwnershipConflict(existing, "contact", row.id)) {
      continue;
    }

    database
      .prepare(
        `
        INSERT INTO platform_identities (
          id, owner_type, owner_id, channel, instance_id, platform_user_id, normalized_platform_user_id,
          platform_display_name, profile_data_json, is_primary, confidence, linked_by, link_reason,
          first_seen_at, last_seen_at, created_at, updated_at
        )
        VALUES (?, 'contact', ?, ?, '', ?, ?, ?, ?, ?, 1.0, 'initial', 'legacy_backfill', ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')), datetime('now'))
        ON CONFLICT(channel, instance_id, normalized_platform_user_id) DO UPDATE SET
          owner_type = excluded.owner_type,
          owner_id = excluded.owner_id,
          platform_user_id = excluded.platform_user_id,
          platform_display_name = COALESCE(excluded.platform_display_name, platform_identities.platform_display_name),
          profile_data_json = excluded.profile_data_json,
          is_primary = MAX(platform_identities.is_primary, excluded.is_primary),
          last_seen_at = excluded.last_seen_at,
          updated_at = datetime('now')
        WHERE platform_identities.owner_type IS NULL
           OR (platform_identities.owner_type = 'contact' AND platform_identities.owner_id = excluded.owner_id)
      `,
      )
      .run(
        platformIdentityId,
        row.id,
        mapped.channel,
        identity.identity_value,
        mapped.normalizedValue,
        row.name,
        metadataJson({ legacyPlatform: identity.platform }),
        identity.is_primary,
        identity.created_at,
        identity.created_at,
        identity.created_at,
      );

    database
      .prepare(
        `
        INSERT OR IGNORE INTO identity_link_events (
          id, event_type, target_owner_type, target_owner_id, platform_identity_id,
          confidence, reason, actor_type, metadata_json
        )
        VALUES (?, 'link', 'contact', ?, ?, 1.0, 'legacy_backfill', 'system', ?)
      `,
      )
      .run(
        stableId("ile", ["link", row.id, platformIdentityId, "legacy_backfill"]),
        row.id,
        platformIdentityId,
        metadataJson({ sourceTable: "contact_identities", legacyPlatform: identity.platform }),
      );
  }
}

function backfillIdentityModel(database: Database): void {
  const contactRows = database.prepare("SELECT id FROM contacts_v2").all() as Array<{ id: string }>;
  const txn = database.transaction(() => {
    for (const row of contactRows) {
      syncContactProjection(database, row.id);
    }
  });
  txn();
}

function ensureIdentityProjection(database: Database): void {
  const sourceFingerprint = identityProjectionSourceFingerprint(database);
  if (getStoredIdentityProjectionFingerprint(database) === sourceFingerprint) return;

  if (identityProjectionLooksComplete(database)) {
    try {
      markIdentityProjectionCurrent(database, sourceFingerprint);
    } catch {
      // A reader can safely continue with complete projections even if another
      // process currently holds the write lock for this optimization marker.
    }
    return;
  }

  backfillIdentityModel(database);
  markIdentityProjectionCurrent(database, sourceFingerprint);
}

// ============================================================================
// ID Generation
// ============================================================================

function generateId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

// ============================================================================
// Types
// ============================================================================

export type ContactStatus = "allowed" | "pending" | "blocked" | "discovered";
export type ReplyMode = "auto" | "mention";
export type ContactSource = "inbound" | "outbound" | "manual" | "discovered";

export interface ContactIdentity {
  platform: string;
  value: string;
  isPrimary: boolean;
  createdAt: string;
}

export interface CanonicalContact {
  id: string;
  kind: "person" | "org";
  displayName: string | null;
  primaryPhone: string | null;
  primaryEmail: string | null;
  avatarUrl: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlatformIdentity {
  id: string;
  ownerType: "contact" | "agent" | null;
  ownerId: string | null;
  channel: string;
  instanceId: string;
  platformUserId: string;
  normalizedPlatformUserId: string;
  platformDisplayName: string | null;
  avatarUrl: string | null;
  profileData: unknown;
  isPrimary: boolean;
  confidence: number;
  linkedBy: string | null;
  linkReason: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContactPolicy {
  contactId: string;
  status: ContactStatus;
  replyMode: ReplyMode;
  allowedAgents: string[] | null;
  optOut: boolean;
  tags: string[];
  notes: Record<string, unknown>;
  source: ContactSource | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  interactionCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface DuplicateCandidate {
  contact: CanonicalContact;
  reasons: string[];
  confidence: "high" | "medium" | "low";
}

export interface ContactDetails {
  contact: CanonicalContact;
  platformIdentities: PlatformIdentity[];
  policy: ContactPolicy | null;
  duplicateCandidates: DuplicateCandidate[];
  legacyContact: Contact | null;
}

export interface Contact {
  id: string;
  phone: string; // primary identity value (backward compat)
  name: string | null;
  email: string | null;
  status: ContactStatus;
  agent_id: string | null;
  reply_mode: ReplyMode;
  tags: string[];
  notes: Record<string, unknown>;
  opt_out: boolean;
  source: ContactSource | null;
  allowedAgents: string[] | null;
  identities: ContactIdentity[];
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  interaction_count: number;
  created_at: string;
  updated_at: string;
}

// Raw SQLite row shapes
interface ContactV2Row {
  id: string;
  name: string | null;
  email: string | null;
  status: string;
  agent_id: string | null;
  reply_mode: string | null;
  tags: string | null;
  notes: string | null;
  opt_out: number | null;
  source: string | null;
  allowed_agents: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  interaction_count: number | null;
  created_at: string;
  updated_at: string;
}

interface IdentityRow {
  contact_id: string;
  platform: string;
  identity_value: string;
  is_primary: number;
  created_at: string;
}

interface CanonicalContactRow {
  id: string;
  kind: "person" | "org";
  display_name: string | null;
  primary_phone: string | null;
  primary_email: string | null;
  avatar_url: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

interface PlatformIdentityRow {
  id: string;
  owner_type: "contact" | "agent" | null;
  owner_id: string | null;
  channel: string;
  instance_id: string;
  platform_user_id: string;
  normalized_platform_user_id: string;
  platform_display_name: string | null;
  avatar_url: string | null;
  profile_data_json: string | null;
  is_primary: number;
  confidence: number;
  linked_by: string | null;
  link_reason: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ContactPolicyRow {
  contact_id: string;
  status: string;
  reply_mode: string;
  allowed_agents_json: string | null;
  opt_out: number;
  tags_json: string | null;
  notes_json: string | null;
  source: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  interaction_count: number;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// Prepared Statements
// ============================================================================

function createStatements(database: Database) {
  return {
    getContactById: database.prepare("SELECT * FROM contacts_v2 WHERE id = ?"),
    getContactByIdentity: database.prepare(`
      SELECT c.* FROM contacts_v2 c
      JOIN contact_identities ci ON ci.contact_id = c.id
      WHERE ci.identity_value = ? COLLATE NOCASE
      LIMIT 1
    `),
    getIdentities: database.prepare(
      "SELECT * FROM contact_identities WHERE contact_id = ? ORDER BY is_primary DESC, created_at",
    ),
    getAllContacts: database.prepare("SELECT * FROM contacts_v2 ORDER BY status, name, id"),
    getContactsByStatus: database.prepare("SELECT * FROM contacts_v2 WHERE status = ? ORDER BY name, id"),
    deleteContact: database.prepare("DELETE FROM contacts_v2 WHERE id = ?"),
    deleteIdentity: database.prepare(
      "DELETE FROM contact_identities WHERE platform = ? AND identity_value = ? COLLATE NOCASE",
    ),
    insertContact: database.prepare(`
      INSERT INTO contacts_v2 (id, name, email, status, source, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `),
    insertIdentity: database.prepare(`
      INSERT INTO contact_identities (contact_id, platform, identity_value, is_primary)
      VALUES (?, ?, ?, ?)
    `),
    updateStatus: database.prepare("UPDATE contacts_v2 SET status = ?, updated_at = datetime('now') WHERE id = ?"),
    updateReplyMode: database.prepare(
      "UPDATE contacts_v2 SET reply_mode = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    upsertPending: database.prepare(`
      INSERT INTO contacts_v2 (id, name, status, source, updated_at)
      VALUES (?, ?, 'pending', 'inbound', datetime('now'))
    `),
    recordInbound: database.prepare(
      "UPDATE contacts_v2 SET last_inbound_at = datetime('now'), interaction_count = interaction_count + 1, updated_at = datetime('now') WHERE id = ?",
    ),
    recordOutbound: database.prepare(
      "UPDATE contacts_v2 SET last_outbound_at = datetime('now'), interaction_count = interaction_count + 1, updated_at = datetime('now') WHERE id = ?",
    ),
    searchContacts: database.prepare(`
      SELECT DISTINCT c.* FROM contacts_v2 c
      LEFT JOIN contact_identities ci ON ci.contact_id = c.id
      WHERE c.name LIKE ? OR c.email LIKE ? OR ci.identity_value LIKE ?
      ORDER BY c.name, c.id
    `),
    findByTag: database.prepare(`
      SELECT c.* FROM contacts_v2 c, json_each(c.tags) AS t WHERE t.value = ? ORDER BY c.name, c.id
    `),
    getIdentityByValue: database.prepare("SELECT * FROM contact_identities WHERE identity_value = ? COLLATE NOCASE"),
    moveIdentities: database.prepare("UPDATE contact_identities SET contact_id = ? WHERE contact_id = ?"),
  };
}

// ============================================================================
// Internal Helpers
// ============================================================================

function getIdentitiesForContact(contactId: string): ContactIdentity[] {
  const rows = getStatements().getIdentities.all(contactId) as IdentityRow[];
  return rows.map((r) => ({
    platform: r.platform,
    value: r.identity_value,
    isPrimary: r.is_primary === 1,
    createdAt: r.created_at,
  }));
}

function rowToContact(row: ContactV2Row): Contact {
  ensureDb();
  const identities = getIdentitiesForContact(row.id);
  // Primary identity value for backward compat (phone field)
  const primary = identities.find((i) => i.isPrimary) ?? identities[0];
  return {
    id: row.id,
    phone: primary?.value ?? row.id,
    name: row.name,
    email: row.email ?? null,
    status: (row.status ?? "allowed") as ContactStatus,
    agent_id: row.agent_id,
    reply_mode: (row.reply_mode ?? "auto") as ReplyMode,
    tags: row.tags ? JSON.parse(row.tags) : [],
    notes: row.notes ? JSON.parse(row.notes) : {},
    opt_out: (row.opt_out ?? 0) === 1,
    source: (row.source as ContactSource) ?? null,
    allowedAgents: row.allowed_agents ? JSON.parse(row.allowed_agents) : null,
    identities,
    last_inbound_at: row.last_inbound_at,
    last_outbound_at: row.last_outbound_at,
    interaction_count: row.interaction_count ?? 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToCanonicalContact(row: CanonicalContactRow): CanonicalContact {
  return {
    id: row.id,
    kind: row.kind,
    displayName: row.display_name,
    primaryPhone: row.primary_phone,
    primaryEmail: row.primary_email,
    avatarUrl: row.avatar_url,
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToPlatformIdentity(row: PlatformIdentityRow): PlatformIdentity {
  return {
    id: row.id,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    channel: row.channel,
    instanceId: row.instance_id,
    platformUserId: row.platform_user_id,
    normalizedPlatformUserId: row.normalized_platform_user_id,
    platformDisplayName: row.platform_display_name,
    avatarUrl: row.avatar_url,
    profileData: parseJsonValue(row.profile_data_json),
    isPrimary: row.is_primary === 1,
    confidence: row.confidence,
    linkedBy: row.linked_by,
    linkReason: row.link_reason,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToContactPolicy(row: ContactPolicyRow): ContactPolicy {
  return {
    contactId: row.contact_id,
    status: (row.status ?? "allowed") as ContactStatus,
    replyMode: (row.reply_mode ?? "auto") as ReplyMode,
    allowedAgents: parseJsonArray(row.allowed_agents_json) as string[] | null,
    optOut: row.opt_out === 1,
    tags: (parseJsonArray(row.tags_json) as string[] | null) ?? [],
    notes: parseJsonObject(row.notes_json) ?? {},
    source: (row.source as ContactSource) ?? null,
    lastInboundAt: row.last_inbound_at,
    lastOutboundAt: row.last_outbound_at,
    interactionCount: row.interaction_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getCanonicalContactById(database: Database, contactId: string): CanonicalContact | null {
  const row = database.prepare("SELECT * FROM contacts WHERE id = ?").get(contactId) as CanonicalContactRow | undefined;
  return row ? rowToCanonicalContact(row) : null;
}

function getPlatformIdentitiesForOwner(database: Database, ownerId: string): PlatformIdentity[] {
  const rows = database
    .prepare(
      `
      SELECT * FROM platform_identities
      WHERE owner_type = 'contact' AND owner_id = ?
      ORDER BY is_primary DESC, channel, normalized_platform_user_id
    `,
    )
    .all(ownerId) as PlatformIdentityRow[];
  return rows.map(rowToPlatformIdentity);
}

function getContactPolicyById(database: Database, contactId: string): ContactPolicy | null {
  const row = database.prepare("SELECT * FROM contact_policies WHERE contact_id = ?").get(contactId) as
    | ContactPolicyRow
    | undefined;
  return row ? rowToContactPolicy(row) : null;
}

function getContactDetailsByCanonicalId(
  database: Database,
  contactId: string,
  options: { includeDuplicateCandidates?: boolean } = {},
): ContactDetails | null {
  const contact = getCanonicalContactById(database, contactId);
  if (!contact) return null;

  return {
    contact,
    platformIdentities: getPlatformIdentitiesForOwner(database, contact.id),
    policy: getContactPolicyById(database, contact.id),
    duplicateCandidates: options.includeDuplicateCandidates === false ? [] : getContactDuplicateCandidates(contact.id),
    legacyContact: getContactById(contact.id),
  };
}

function findPlatformIdentityByRef(database: Database, platformIdentityRef: string): PlatformIdentityRow | null {
  const normalized = normalizePhone(platformIdentityRef);
  const emailNormalized = platformIdentityRef.trim().toLowerCase();
  const row = database
    .prepare(
      `
      SELECT * FROM platform_identities
      WHERE id = ?
         OR normalized_platform_user_id = ? COLLATE NOCASE
         OR normalized_platform_user_id = ? COLLATE NOCASE
         OR platform_user_id = ? COLLATE NOCASE
      LIMIT 1
    `,
    )
    .get(platformIdentityRef, normalized, emailNormalized, platformIdentityRef) as PlatformIdentityRow | undefined;
  return row ?? null;
}

function canonicalRows(database: Database): CanonicalContact[] {
  return (database.prepare("SELECT * FROM contacts ORDER BY display_name, id").all() as CanonicalContactRow[]).map(
    rowToCanonicalContact,
  );
}

function normalizeIdentityComparisonValue(identity: PlatformIdentity): string | null {
  if (identity.channel === "email") return identity.normalizedPlatformUserId.toLowerCase();
  if (identity.channel === "phone" || /^\d+$/.test(identity.normalizedPlatformUserId)) {
    return normalizePhone(identity.normalizedPlatformUserId);
  }
  return null;
}

function buildDuplicateCandidates(database: Database): Map<string, DuplicateCandidate[]> {
  const contacts = canonicalRows(database);
  const contactsById = new Map(contacts.map((contact) => [contact.id, contact]));
  const candidatesByContact = new Map<string, Map<string, Set<string>>>();

  const addCandidate = (leftId: string, rightId: string, reason: string) => {
    if (leftId === rightId) return;
    const leftCandidates = candidatesByContact.get(leftId) ?? new Map<string, Set<string>>();
    const reasons = leftCandidates.get(rightId) ?? new Set<string>();
    reasons.add(reason);
    leftCandidates.set(rightId, reasons);
    candidatesByContact.set(leftId, leftCandidates);
  };

  const addPair = (leftId: string, rightId: string, reason: string) => {
    addCandidate(leftId, rightId, reason);
    addCandidate(rightId, leftId, reason);
  };

  const addGroups = (groups: Map<string, string[]>, reason: string) => {
    for (const ids of groups.values()) {
      if (ids.length < 2) continue;
      for (let i = 0; i < ids.length; i += 1) {
        for (let j = i + 1; j < ids.length; j += 1) {
          addPair(ids[i]!, ids[j]!, reason);
        }
      }
    }
  };

  const phoneGroups = new Map<string, string[]>();
  const emailGroups = new Map<string, string[]>();
  for (const contact of contacts) {
    if (contact.primaryPhone) {
      const key = normalizePhone(contact.primaryPhone);
      phoneGroups.set(key, [...(phoneGroups.get(key) ?? []), contact.id]);
    }
    if (contact.primaryEmail) {
      const key = contact.primaryEmail.toLowerCase();
      emailGroups.set(key, [...(emailGroups.get(key) ?? []), contact.id]);
    }
  }
  addGroups(phoneGroups, "same primary phone");
  addGroups(emailGroups, "same primary email");

  const identityGroups = new Map<string, { reason: string; ids: string[] }>();
  const identityRows = database
    .prepare(
      `
      SELECT * FROM platform_identities
      WHERE owner_type = 'contact' AND owner_id IS NOT NULL
    `,
    )
    .all() as PlatformIdentityRow[];
  for (const row of identityRows) {
    const identity = rowToPlatformIdentity(row);
    const comparable = normalizeIdentityComparisonValue(identity);
    if (!comparable || !identity.ownerId) continue;
    const key = `${identity.channel}\x1f${comparable}`;
    const group = identityGroups.get(key) ?? {
      reason: `same normalized ${identity.channel} identity`,
      ids: [],
    };
    group.ids.push(identity.ownerId);
    identityGroups.set(key, group);
  }
  for (const group of identityGroups.values()) {
    addGroups(new Map([[group.reason, [...new Set(group.ids)]]]), group.reason);
  }

  const result = new Map<string, DuplicateCandidate[]>();
  for (const [contactId, candidates] of candidatesByContact) {
    const duplicateCandidates = [...candidates.entries()]
      .map<DuplicateCandidate | null>(([candidateId, reasons]) => {
        const contact = contactsById.get(candidateId);
        if (!contact) return null;
        return { contact, reasons: [...reasons], confidence: "high" };
      })
      .filter((candidate): candidate is DuplicateCandidate => candidate !== null);
    result.set(contactId, duplicateCandidates);
  }
  return result;
}

export function getContactDuplicateCandidates(contactId: string): DuplicateCandidate[] {
  const database = ensureDb();
  if (!getCanonicalContactById(database, contactId)) return [];
  return buildDuplicateCandidates(database).get(contactId) ?? [];
}

export function listDuplicateContacts(): Array<{
  contact: CanonicalContact;
  duplicateCandidates: DuplicateCandidate[];
}> {
  const database = ensureDb();
  const candidates = buildDuplicateCandidates(database);
  return canonicalRows(database)
    .map((contact) => ({ contact, duplicateCandidates: candidates.get(contact.id) ?? [] }))
    .filter((entry) => entry.duplicateCandidates.length > 0);
}

export function getContactDetails(
  contactRef: string,
  options: { includeDuplicateCandidates?: boolean } = {},
): ContactDetails | null {
  const database = ensureDb();
  const legacyContact = resolveContact(contactRef);
  if (legacyContact) {
    if (isLegacyGroupOnlyContact(legacyContact)) return null;
    if (!contactProjectionIsCurrent(database, legacyContact)) {
      syncContactProjection(database, legacyContact.id);
      try {
        markIdentityProjectionCurrent(database);
      } catch {
        // The projection itself is current; the meta marker is only a startup
        // optimization and must not make read paths fail under concurrent CLI use.
      }
    }
    return getContactDetailsByCanonicalId(database, legacyContact.id, options);
  }

  const canonicalById = getContactDetailsByCanonicalId(database, contactRef, options);
  if (canonicalById) return canonicalById;

  const identity = findPlatformIdentityByRef(database, contactRef);
  if (identity?.owner_type === "contact" && identity.owner_id) {
    return getContactDetailsByCanonicalId(database, identity.owner_id, options);
  }

  return null;
}

function findPlatformIdentityByChannelRef(
  database: Database,
  input: { channel: string; instanceId?: string | null; platformUserId: string },
): PlatformIdentityRow | null {
  const channel = normalizePlatformIdentityChannel(input.channel);
  const instanceId = input.instanceId?.trim() ?? "";
  const normalized = normalizeIdentityForChannel(channel, input.platformUserId);
  const row = database
    .prepare(
      `
      SELECT * FROM platform_identities
      WHERE channel = ? AND instance_id = ? AND normalized_platform_user_id = ?
      LIMIT 1
    `,
    )
    .get(channel, instanceId, normalized) as PlatformIdentityRow | undefined;
  return row ?? null;
}

function platformIdentityOwnershipConflict(
  existing: PlatformIdentityRow | null,
  ownerType: "contact" | "agent",
  ownerId: string,
): string | null {
  if (!existing?.owner_type) return null;
  if (existing.owner_type === ownerType && existing.owner_id === ownerId) return null;
  return `Platform identity ${existing.id} is owned by ${existing.owner_type} ${existing.owner_id}`;
}

function assertPlatformIdentityCanBeOwnedBy(
  existing: PlatformIdentityRow | null,
  ownerType: "contact" | "agent",
  ownerId: string,
): void {
  const conflict = platformIdentityOwnershipConflict(existing, ownerType, ownerId);
  if (conflict) throw new Error(conflict);
}

export function resolvePlatformIdentity(input: {
  channel: string;
  instanceId?: string | null;
  platformUserId: string;
}): PlatformIdentity | null {
  const row = findPlatformIdentityByChannelRef(ensureDb(), input);
  return row ? rowToPlatformIdentity(row) : null;
}

export function getAgentPlatformIdentity(input: {
  agentId: string;
  channel?: string | null;
  instanceId?: string | null;
}): PlatformIdentity | null {
  const database = ensureDb();
  const clauses = ["owner_type = 'agent'", "owner_id = ?"];
  const values: string[] = [input.agentId];
  if (input.channel) {
    clauses.push("channel = ?");
    values.push(normalizePlatformIdentityChannel(input.channel));
  }
  if (input.instanceId !== undefined) {
    clauses.push("instance_id = ?");
    values.push(input.instanceId?.trim() ?? "");
  }

  const row = database
    .prepare(
      `
      SELECT * FROM platform_identities
      WHERE ${clauses.join(" AND ")}
      ORDER BY is_primary DESC, updated_at DESC
      LIMIT 1
    `,
    )
    .get(...values) as PlatformIdentityRow | undefined;
  return row ? rowToPlatformIdentity(row) : null;
}

export function upsertAgentPlatformIdentity(input: {
  agentId: string;
  channel: string;
  instanceId?: string | null;
  platformUserId: string;
  platformDisplayName?: string | null;
  avatarUrl?: string | null;
  profileData?: unknown;
  isPrimary?: boolean;
  confidence?: number;
  linkedBy?: string | null;
  linkReason?: string | null;
}): PlatformIdentity {
  const database = ensureDb();
  const agentId = input.agentId.trim();
  if (!agentId) throw new Error("Agent id is required");
  const channel = normalizePlatformIdentityChannel(input.channel);
  if (!channel) throw new Error("Channel is required");
  const instanceId = input.instanceId?.trim() ?? "";
  const rawPlatformUserId = input.platformUserId.trim();
  if (!rawPlatformUserId) throw new Error("Platform user id is required");
  const normalizedPlatformUserId = normalizeIdentityForChannel(channel, rawPlatformUserId);
  if (!normalizedPlatformUserId) throw new Error("Normalized platform user id is required");

  const existing = findPlatformIdentityByChannelRef(database, {
    channel,
    instanceId,
    platformUserId: rawPlatformUserId,
  });
  if (existing?.owner_type === "contact") {
    throw new Error(`Platform identity ${existing.id} is owned by contact ${existing.owner_id}`);
  }
  if (existing?.owner_type === "agent" && existing.owner_id !== agentId) {
    throw new Error(`Platform identity ${existing.id} is owned by agent ${existing.owner_id}`);
  }

  const platformIdentityId = stableId("pi", [instanceId, channel, normalizedPlatformUserId]);
  const profileDataJson =
    input.profileData === undefined
      ? metadataJson({ source: "agent_platform_identity", rawPlatformUserId, instanceId })
      : JSON.stringify(input.profileData);
  const confidence = input.confidence ?? 1.0;
  const linkedBy = input.linkedBy ?? "initial";
  const linkReason = input.linkReason ?? "agent_channel_account";

  database
    .prepare(
      `
      INSERT INTO platform_identities (
        id, owner_type, owner_id, channel, instance_id, platform_user_id, normalized_platform_user_id,
        platform_display_name, avatar_url, profile_data_json, is_primary, confidence, linked_by, link_reason,
        first_seen_at, last_seen_at, created_at, updated_at
      )
      VALUES (?, 'agent', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now'), datetime('now'))
      ON CONFLICT(channel, instance_id, normalized_platform_user_id) DO UPDATE SET
        owner_type = excluded.owner_type,
        owner_id = excluded.owner_id,
        platform_user_id = excluded.platform_user_id,
        platform_display_name = COALESCE(excluded.platform_display_name, platform_identities.platform_display_name),
        avatar_url = COALESCE(excluded.avatar_url, platform_identities.avatar_url),
        profile_data_json = COALESCE(excluded.profile_data_json, platform_identities.profile_data_json),
        is_primary = MAX(platform_identities.is_primary, excluded.is_primary),
        confidence = excluded.confidence,
        linked_by = excluded.linked_by,
        link_reason = excluded.link_reason,
        last_seen_at = datetime('now'),
        updated_at = datetime('now')
    `,
    )
    .run(
      platformIdentityId,
      agentId,
      channel,
      instanceId,
      rawPlatformUserId,
      normalizedPlatformUserId,
      input.platformDisplayName ?? null,
      input.avatarUrl ?? null,
      profileDataJson,
      input.isPrimary === false ? 0 : 1,
      confidence,
      linkedBy,
      linkReason,
    );

  database
    .prepare(
      `
      INSERT OR IGNORE INTO identity_link_events (
        id, event_type, target_owner_type, target_owner_id, platform_identity_id,
        confidence, reason, actor_type, metadata_json
      )
      VALUES (?, 'link', 'agent', ?, ?, ?, ?, 'system', ?)
    `,
    )
    .run(
      stableId("ile", ["link", "agent", agentId, platformIdentityId, linkReason]),
      agentId,
      platformIdentityId,
      confidence,
      linkReason,
      metadataJson({ source: "agent_platform_identity", channel, instanceId }),
    );

  const row = findPlatformIdentityByChannelRef(database, {
    channel,
    instanceId,
    platformUserId: rawPlatformUserId,
  });
  if (!row) throw new Error(`Platform identity not found after agent upsert: ${channel}:${normalizedPlatformUserId}`);
  return rowToPlatformIdentity(row);
}

export function setContactKind(contactRef: string, kind: "person" | "org"): ContactDetails {
  const database = ensureDb();
  const legacyContact = resolveContact(contactRef);
  if (!legacyContact) throw new Error(`Contact not found: ${contactRef}`);
  syncContactProjection(database, legacyContact.id);
  database
    .prepare("UPDATE contacts SET kind = ?, updated_at = datetime('now') WHERE id = ?")
    .run(kind, legacyContact.id);
  const details = getContactDetails(legacyContact.id);
  if (!details) throw new Error(`Contact is not canonical: ${legacyContact.id}`);
  return details;
}

/** Detect platform from a normalized identity value */
function detectPlatform(identity: string): string {
  if (identity.startsWith("lid:")) return "whatsapp_lid";
  if (identity.startsWith("group:")) return "whatsapp_group";
  return "phone";
}

/** Resolve any identity string to a Contact (or null) */
function resolveContact(identity: string): Contact | null {
  const statements = getStatements();
  const normalized = normalizePhone(identity);

  // Try by identity_value first
  const row = statements.getContactByIdentity.get(normalized) as ContactV2Row | undefined;
  if (row) return rowToContact(row);

  // Try by contact ID directly (short UUID)
  const byId = statements.getContactById.get(normalized) as ContactV2Row | undefined;
  if (byId) return rowToContact(byId);

  // Also try the raw input as ID (in case it's already an ID)
  if (identity !== normalized) {
    const byRawId = statements.getContactById.get(identity) as ContactV2Row | undefined;
    if (byRawId) return rowToContact(byRawId);
  }

  // If input is pure digits, also try as LID (common case: LID passed without prefix)
  if (/^\d+$/.test(normalized) && !normalized.startsWith("lid:")) {
    const asLid = statements.getContactByIdentity.get(`lid:${normalized}`) as ContactV2Row | undefined;
    if (asLid) return rowToContact(asLid);
  }

  return null;
}

// ============================================================================
// Public API — backward-compatible signatures
// ============================================================================

/**
 * Get a contact by any identity (phone, LID, group, user_id)
 */
export function getContact(phone: string): Contact | null {
  return resolveContact(phone);
}

/**
 * Get a contact by its v2 UUID
 */
export function getContactById(id: string): Contact | null {
  const row = getStatements().getContactById.get(id) as ContactV2Row | undefined;
  return row ? rowToContact(row) : null;
}

/**
 * Check if an identity is allowed
 */
export function isAllowed(phone: string): boolean {
  const contact = getContact(phone);
  if (!contact) return false;
  return contact.status === "allowed";
}

/**
 * Get all contacts
 */
export function getAllContacts(): Contact[] {
  return (getStatements().getAllContacts.all() as ContactV2Row[]).map(rowToContact);
}

/**
 * Get contacts by status
 */
export function getContactsByStatus(status: ContactStatus): Contact[] {
  return (getStatements().getContactsByStatus.all(status) as ContactV2Row[]).map(rowToContact);
}

/**
 * Get pending contacts
 */
export function getPendingContacts(): Contact[] {
  return getContactsByStatus("pending");
}

/**
 * Add or update a contact with explicit status.
 * If the identity already exists, updates the existing contact.
 * If not, creates a new contact with this identity.
 */
export function upsertContact(
  phone: string,
  name?: string | null,
  status: ContactStatus = "allowed",
  source?: ContactSource | null,
): void {
  const database = ensureDb();
  const statements = getStatements();
  const normalized = assertPersonOrOrgIdentity(phone, "upsertContact");
  const existing = resolveContact(normalized);

  if (existing) {
    // Update existing
    const fields: string[] = [];
    const values: (string | number | null)[] = [];
    if (name !== undefined && name !== null) {
      fields.push("name = COALESCE(?, name)");
      values.push(name);
    }
    fields.push("status = ?");
    values.push(status);
    if (source) {
      fields.push("source = ?");
      values.push(source);
    }
    fields.push("updated_at = datetime('now')");
    values.push(existing.id);
    database.prepare(`UPDATE contacts_v2 SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    syncContactProjection(database, existing.id);
  } else {
    // Create new
    const id = generateId();
    const platform = detectPlatform(normalized);
    statements.insertContact.run(id, name ?? null, null, status, source ?? null);
    statements.insertIdentity.run(id, platform, normalized, 1);
    syncContactProjection(database, id);
  }
}

/**
 * Save a pending contact (updates name but doesn't change status if exists)
 */
export function savePendingContact(phone: string, name?: string | null): boolean {
  const database = ensureDb();
  const statements = getStatements();
  const normalized = assertPersonOrOrgIdentity(phone, "savePendingContact");
  const existing = resolveContact(normalized);

  if (existing) {
    // Update name only, don't change status
    if (name) {
      database
        .prepare("UPDATE contacts_v2 SET name = COALESCE(name, ?), updated_at = datetime('now') WHERE id = ?")
        .run(name, existing.id);
      syncContactProjection(database, existing.id);
    }
    return false;
  } else {
    // Create new pending contact
    const id = generateId();
    const platform = detectPlatform(normalized);
    statements.upsertPending.run(id, name ?? null);
    statements.insertIdentity.run(id, platform, normalized, 1);
    syncContactProjection(database, id);
    return true;
  }
}

/**
 * Delete a contact (by any identity or ID)
 */
export function deleteContact(phone: string): boolean {
  const database = ensureDb();
  const statements = getStatements();
  const contact = resolveContact(phone);
  if (!contact) return false;
  statements.deleteContact.run(contact.id);
  deleteContactProjection(database, contact.id);
  return true;
}

/**
 * Set contact status and optionally agent
 */
export function setContactStatus(phone: string, status: ContactStatus): void {
  const statements = getStatements();
  const normalized = assertPersonOrOrgIdentity(phone, "setContactStatus");
  const contact = resolveContact(normalized);
  if (!contact) {
    upsertContact(normalized, null, status);
  } else {
    statements.updateStatus.run(status, contact.id);
    syncContactProjection(ensureDb(), contact.id);
  }
}

/**
 * Allow a contact
 */
export function allowContact(phone: string): void {
  setContactStatus(phone, "allowed");
}

/**
 * Get reply mode for a contact
 */
export function getContactReplyMode(phone: string): ReplyMode {
  const contact = getContact(phone);
  return contact?.reply_mode ?? "auto";
}

/**
 * Set reply mode for a contact
 */
export function setContactReplyMode(phone: string, mode: ReplyMode): void {
  const statements = getStatements();
  const contact = resolveContact(phone);
  if (contact) {
    statements.updateReplyMode.run(mode, contact.id);
    syncContactProjection(ensureDb(), contact.id);
  }
}

/**
 * Block a contact
 */
export function blockContact(phone: string): void {
  setContactStatus(phone, "blocked");
}

/**
 * Get contact name (returns null if not found or no name)
 */
export function getContactName(phone: string): string | null {
  const contact = getContact(phone);
  return contact?.name ?? null;
}

/**
 * Save a discovered contact (from group membership).
 * Creates as 'discovered' if new, updates name if exists but has no name.
 */
export function saveDiscoveredContact(phone: string, name?: string | null): void {
  const database = ensureDb();
  const statements = getStatements();
  const normalized = assertPersonOrOrgIdentity(phone, "saveDiscoveredContact");
  const existing = resolveContact(normalized);

  if (existing) {
    // Update name only if not set
    if (name) {
      database
        .prepare("UPDATE contacts_v2 SET name = COALESCE(name, ?), updated_at = datetime('now') WHERE id = ?")
        .run(name, existing.id);
      syncContactProjection(database, existing.id);
    }
  } else {
    const id = generateId();
    const platform = detectPlatform(normalized);
    database
      .prepare(`
      INSERT INTO contacts_v2 (id, name, status, source, updated_at)
      VALUES (?, ?, 'discovered', 'discovered', datetime('now'))
    `)
      .run(id, name ?? null);
    statements.insertIdentity.run(id, platform, normalized, 1);
    syncContactProjection(database, id);
  }
}

/**
 * Create a contact with extended fields
 */
export function createContact(input: {
  phone: string;
  name?: string;
  email?: string;
  status?: ContactStatus;
  source?: ContactSource;
  tags?: string[];
  notes?: Record<string, unknown>;
}): Contact {
  const database = ensureDb();
  const statements = getStatements();
  const normalized = assertPersonOrOrgIdentity(input.phone, "createContact");
  const existing = resolveContact(normalized);
  if (existing) {
    throw new Error(`Contact already exists: ${normalized}`);
  }

  const id = generateId();
  const platform = detectPlatform(normalized);

  database
    .prepare(`
    INSERT INTO contacts_v2 (id, name, email, status, source, tags, notes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `)
    .run(
      id,
      input.name ?? null,
      input.email ?? null,
      input.status ?? "allowed",
      input.source ?? null,
      input.tags ? JSON.stringify(input.tags) : null,
      input.notes ? JSON.stringify(input.notes) : null,
    );

  statements.insertIdentity.run(id, platform, normalized, 1);
  syncContactProjection(database, id);
  return getContactById(id)!;
}

/**
 * Update contact fields
 */
export function updateContact(
  phone: string,
  updates: {
    name?: string | null;
    email?: string | null;
    status?: ContactStatus;
    reply_mode?: ReplyMode;
    tags?: string[];
    notes?: Record<string, unknown>;
    opt_out?: boolean;
    source?: ContactSource | null;
    allowedAgents?: string[] | null;
  },
): Contact {
  const database = ensureDb();
  const contact = resolveContact(phone);
  if (!contact) {
    throw new Error(`Contact not found: ${phone}`);
  }

  type SQLValue = string | number | null;
  const fields: string[] = [];
  const values: SQLValue[] = [];

  if (updates.name !== undefined) {
    fields.push("name = ?");
    values.push(updates.name);
  }
  if (updates.email !== undefined) {
    fields.push("email = ?");
    values.push(updates.email);
  }
  if (updates.status !== undefined) {
    fields.push("status = ?");
    values.push(updates.status);
  }
  if (updates.reply_mode !== undefined) {
    fields.push("reply_mode = ?");
    values.push(updates.reply_mode);
  }
  if (updates.tags !== undefined) {
    fields.push("tags = ?");
    values.push(JSON.stringify(updates.tags));
  }
  if (updates.notes !== undefined) {
    fields.push("notes = ?");
    values.push(JSON.stringify(updates.notes));
  }
  if (updates.opt_out !== undefined) {
    fields.push("opt_out = ?");
    values.push(updates.opt_out ? 1 : 0);
  }
  if (updates.source !== undefined) {
    fields.push("source = ?");
    values.push(updates.source);
  }
  if (updates.allowedAgents !== undefined) {
    fields.push("allowed_agents = ?");
    values.push(updates.allowedAgents === null ? null : JSON.stringify(updates.allowedAgents));
  }

  if (fields.length === 0) return contact;

  fields.push("updated_at = datetime('now')");
  values.push(contact.id);

  database.prepare(`UPDATE contacts_v2 SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  syncContactProjection(database, contact.id);
  return getContactById(contact.id)!;
}

/**
 * Find contacts by tag
 */
export function findContactsByTag(tag: string): Contact[] {
  const rows = getStatements().findByTag.all(tag) as ContactV2Row[];
  return rows.map(rowToContact);
}

/**
 * Search contacts by name, email, or any identity value
 */
export function searchContacts(query: string): Contact[] {
  const pattern = `%${query}%`;
  const rows = getStatements().searchContacts.all(pattern, pattern, pattern) as ContactV2Row[];
  return rows.map(rowToContact);
}

/**
 * Merge notes into existing contact notes (shallow merge)
 */
export function mergeContactNotes(phone: string, newNotes: Record<string, unknown>): void {
  const database = ensureDb();
  const contact = resolveContact(phone);
  if (!contact) {
    throw new Error(`Contact not found: ${phone}`);
  }

  const merged = { ...contact.notes, ...newNotes };
  database
    .prepare("UPDATE contacts_v2 SET notes = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(merged), contact.id);
  syncContactProjection(database, contact.id);
}

/**
 * Add a tag to a contact
 */
export function addContactTag(phone: string, tag: string): void {
  const database = ensureDb();
  const contact = resolveContact(phone);
  if (!contact) {
    throw new Error(`Contact not found: ${phone}`);
  }

  if (!contact.tags.includes(tag)) {
    const tags = [...contact.tags, tag];
    database
      .prepare("UPDATE contacts_v2 SET tags = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(tags), contact.id);
    syncContactProjection(database, contact.id);
  }
}

/**
 * Remove a tag from a contact
 */
export function removeContactTag(phone: string, tag: string): void {
  const database = ensureDb();
  const contact = resolveContact(phone);
  if (!contact) {
    throw new Error(`Contact not found: ${phone}`);
  }

  const tags = contact.tags.filter((t) => t !== tag);
  database
    .prepare("UPDATE contacts_v2 SET tags = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(tags), contact.id);
  syncContactProjection(database, contact.id);
}

/**
 * Record an inbound message from a contact
 */
export function recordInbound(phone: string): void {
  const statements = getStatements();
  const contact = resolveContact(phone);
  if (contact) {
    statements.recordInbound.run(contact.id);
    syncContactProjection(ensureDb(), contact.id);
  }
}

/**
 * Record an outbound message to a contact
 */
export function recordOutbound(phone: string): void {
  const statements = getStatements();
  const contact = resolveContact(phone);
  if (contact) {
    statements.recordOutbound.run(contact.id);
    syncContactProjection(ensureDb(), contact.id);
  }
}

/**
 * Check if a contact has opted out
 */
export function isOptedOut(phone: string): boolean {
  const contact = getContact(phone);
  return contact?.opt_out ?? false;
}

/**
 * Set opt-out status for a contact
 */
export function setOptOut(phone: string, optOut: boolean): void {
  const database = ensureDb();
  const contact = resolveContact(phone);
  if (contact) {
    database
      .prepare("UPDATE contacts_v2 SET opt_out = ?, updated_at = datetime('now') WHERE id = ?")
      .run(optOut ? 1 : 0, contact.id);
    syncContactProjection(database, contact.id);
  }
}

// ============================================================================
// New v2 functions — identity management
// ============================================================================

/**
 * Get all identities for a contact
 */
export function getContactIdentities(contactId: string): ContactIdentity[] {
  return getIdentitiesForContact(contactId);
}

/**
 * Add an identity to an existing contact
 */
export function addContactIdentity(contactId: string, platform: string, value: string, isPrimary = false): void {
  const database = ensureDb();
  const statements = getStatements();
  if (legacyIdentityIsGroup(platform, value)) {
    throw new Error("Group/chat identities belong to chats, not contacts");
  }
  const normalized = normalizeLegacyIdentityValue(platform, value);
  const mapped = mapLegacyPlatform(platform, normalized);

  // Check if this identity already belongs to another contact
  const existing = statements.getIdentityByValue.get(normalized) as IdentityRow | undefined;
  if (existing) {
    if (existing.contact_id === contactId) return; // already linked
    throw new Error(`Identity ${normalized} already belongs to contact ${existing.contact_id}`);
  }
  if (mapped) {
    assertPlatformIdentityCanBeOwnedBy(
      findPlatformIdentityByChannelRef(database, {
        channel: mapped.channel,
        instanceId: "",
        platformUserId: mapped.normalizedValue,
      }),
      "contact",
      contactId,
    );
  }

  statements.insertIdentity.run(contactId, platform, normalized, isPrimary ? 1 : 0);
  syncContactProjection(database, contactId);
}

/**
 * Remove an identity from a contact
 */
export function removeContactIdentity(platform: string, value: string): void {
  const database = ensureDb();
  const statements = getStatements();
  const normalized = normalizeLegacyIdentityValue(platform, value);
  const existing = statements.getIdentityByValue.get(normalized) as IdentityRow | undefined;
  statements.deleteIdentity.run(platform, normalized);
  if (existing) {
    const mapped = mapLegacyPlatform(platform, normalized);
    if (mapped) {
      database
        .prepare(
          `
          DELETE FROM platform_identities
          WHERE owner_type = 'contact'
            AND owner_id = ?
            AND channel = ?
            AND normalized_platform_user_id = ?
        `,
        )
        .run(existing.contact_id, mapped.channel, mapped.normalizedValue);
    }
    syncContactProjection(database, existing.contact_id);
  }
}

function mapLinkInput(
  channel: string,
  value: string,
): {
  legacyPlatform: string;
  legacyValue: string;
  canonicalChannel: string;
  normalizedValue: string;
} {
  const normalizedChannel = channel.trim().toLowerCase();
  if (!normalizedChannel) throw new Error("Channel is required");

  if (normalizedChannel === "whatsapp_group" || legacyIdentityIsGroup(normalizedChannel, value)) {
    throw new Error("Group/chat identities belong to chats, not contacts");
  }

  if (normalizedChannel === "whatsapp") {
    const normalized = normalizePhone(value);
    if (normalized.startsWith("group:")) {
      throw new Error("Group/chat identities belong to chats, not contacts");
    }
    if (normalized.startsWith("lid:")) {
      return {
        legacyPlatform: "whatsapp_lid",
        legacyValue: normalized,
        canonicalChannel: "whatsapp",
        normalizedValue: normalized,
      };
    }
    return {
      legacyPlatform: "phone",
      legacyValue: normalized,
      canonicalChannel: "phone",
      normalizedValue: normalized,
    };
  }

  if (normalizedChannel === "phone") {
    const normalized = normalizePhone(value);
    return {
      legacyPlatform: "phone",
      legacyValue: normalized,
      canonicalChannel: "phone",
      normalizedValue: normalized,
    };
  }

  if (normalizedChannel === "email") {
    const normalized = normalizeIdentityForChannel("email", value);
    return {
      legacyPlatform: "email",
      legacyValue: normalized,
      canonicalChannel: "email",
      normalizedValue: normalized,
    };
  }

  return {
    legacyPlatform: normalizedChannel,
    legacyValue: value.trim(),
    canonicalChannel: normalizedChannel,
    normalizedValue: normalizeIdentityForChannel(normalizedChannel, value),
  };
}

function upsertCanonicalPlatformIdentity(
  database: Database,
  contactId: string,
  mapped: {
    legacyPlatform: string;
    canonicalChannel: string;
    normalizedValue: string;
  },
  input: { platformUserId: string; instanceId?: string; reason?: string | null },
): PlatformIdentityRow {
  const instanceId = input.instanceId?.trim() ?? "";
  const platformIdentityId = stableId("pi", [instanceId, mapped.canonicalChannel, mapped.normalizedValue]);
  assertPlatformIdentityCanBeOwnedBy(
    findPlatformIdentityByChannelRef(database, {
      channel: mapped.canonicalChannel,
      instanceId,
      platformUserId: mapped.normalizedValue,
    }),
    "contact",
    contactId,
  );

  database
    .prepare(
      `
      INSERT INTO platform_identities (
        id, owner_type, owner_id, channel, instance_id, platform_user_id, normalized_platform_user_id,
        platform_display_name, profile_data_json, is_primary, confidence, linked_by, link_reason,
        first_seen_at, last_seen_at, created_at, updated_at
      )
      VALUES (?, 'contact', ?, ?, ?, ?, ?, NULL, ?, 0, 1.0, 'manual', ?, datetime('now'), datetime('now'), datetime('now'), datetime('now'))
      ON CONFLICT(channel, instance_id, normalized_platform_user_id) DO UPDATE SET
        owner_type = excluded.owner_type,
        owner_id = excluded.owner_id,
        platform_user_id = excluded.platform_user_id,
        profile_data_json = excluded.profile_data_json,
        linked_by = 'manual',
        link_reason = excluded.link_reason,
        last_seen_at = datetime('now'),
        updated_at = datetime('now')
      WHERE platform_identities.owner_type IS NULL
         OR (platform_identities.owner_type = 'contact' AND platform_identities.owner_id = excluded.owner_id)
    `,
    )
    .run(
      platformIdentityId,
      contactId,
      mapped.canonicalChannel,
      instanceId,
      input.platformUserId,
      mapped.normalizedValue,
      metadataJson({
        source: "contacts_cli",
        legacyPlatform: mapped.legacyPlatform,
        rawPlatformUserId: input.platformUserId,
        instanceId,
      }),
      input.reason ?? "manual",
    );

  const row = database
    .prepare(
      "SELECT * FROM platform_identities WHERE channel = ? AND instance_id = ? AND normalized_platform_user_id = ?",
    )
    .get(mapped.canonicalChannel, instanceId, mapped.normalizedValue) as PlatformIdentityRow | undefined;
  if (!row)
    throw new Error(`Platform identity not found after link: ${mapped.canonicalChannel}:${mapped.normalizedValue}`);
  assertPlatformIdentityCanBeOwnedBy(row, "contact", contactId);
  return row;
}

export function linkContactIdentity(
  contactRef: string,
  input: { channel: string; platformUserId: string; instanceId?: string; reason?: string | null },
): ContactDetails {
  const database = ensureDb();
  const contact = resolveContact(contactRef);
  if (!contact) throw new Error(`Contact not found: ${contactRef}`);

  const mapped = mapLinkInput(input.channel, input.platformUserId);
  const instanceId = input.instanceId?.trim() ?? "";
  assertPlatformIdentityCanBeOwnedBy(
    findPlatformIdentityByChannelRef(database, {
      channel: mapped.canonicalChannel,
      instanceId,
      platformUserId: mapped.normalizedValue,
    }),
    "contact",
    contact.id,
  );
  addContactIdentity(contact.id, mapped.legacyPlatform, mapped.legacyValue);
  syncContactProjection(database, contact.id);

  const current = upsertCanonicalPlatformIdentity(database, contact.id, mapped, input);
  database
    .prepare(
      `
      INSERT OR IGNORE INTO identity_link_events (
        id, event_type, target_owner_type, target_owner_id, platform_identity_id,
        confidence, reason, actor_type, metadata_json
      )
      VALUES (?, 'link', 'contact', ?, ?, 1.0, ?, 'system', ?)
    `,
    )
    .run(
      stableId("ile", ["link", contact.id, current.id, input.reason ?? "manual"]),
      contact.id,
      current.id,
      input.reason ?? "manual",
      metadataJson({ source: "contacts_cli", instanceId: current.instance_id }),
    );

  const details = getContactDetails(contact.id);
  if (!details) throw new Error(`Contact is not canonical: ${contact.id}`);
  return details;
}

export function unlinkContactIdentity(
  platformIdentityRef: string,
  reason?: string | null,
  options?: { channel?: string | null; instanceId?: string | null },
): ContactDetails | null {
  const database = ensureDb();
  const channel = options?.channel ? normalizePlatformIdentityChannel(options.channel) : null;
  const instanceId = options?.instanceId?.trim();
  const normalizedRef = platformIdentityRef.startsWith("pi_")
    ? platformIdentityRef
    : channel
      ? normalizeIdentityForChannel(channel, platformIdentityRef)
      : normalizePhone(platformIdentityRef);
  const rows = platformIdentityRef.startsWith("pi_")
    ? (database
        .prepare("SELECT * FROM platform_identities WHERE id = ?")
        .all(platformIdentityRef) as PlatformIdentityRow[])
    : (database
        .prepare(
          `
          SELECT * FROM platform_identities
          WHERE (normalized_platform_user_id = ? COLLATE NOCASE OR platform_user_id = ? COLLATE NOCASE)
            AND (? IS NULL OR channel = ?)
            AND (? IS NULL OR instance_id = ?)
          ORDER BY channel, instance_id, id
        `,
        )
        .all(
          normalizedRef,
          platformIdentityRef,
          channel,
          channel,
          instanceId ?? null,
          instanceId ?? null,
        ) as PlatformIdentityRow[]);

  if (rows.length === 0) return null;
  if (rows.length > 1) {
    const candidates = rows
      .map(
        (candidate) =>
          `${candidate.id} channel=${candidate.channel} instance=${candidate.instance_id || "-"} owner=${
            candidate.owner_type ?? "unresolved"
          }:${candidate.owner_id ?? "-"}`,
      )
      .join("; ");
    throw new Error(
      `Platform identity ref "${platformIdentityRef}" is ambiguous (${rows.length} matches). Use a platform identity id or pass channel/instance. Candidates: ${candidates}`,
    );
  }

  const row = rows[0];
  if (row.owner_type && row.owner_type !== "contact") {
    throw new Error(`Platform identity ${row.id} is owned by ${row.owner_type}, not a contact`);
  }

  const contactId = row.owner_id;
  if (contactId) {
    const legacyPlatform =
      row.channel === "whatsapp" && row.normalized_platform_user_id.startsWith("lid:") ? "whatsapp_lid" : row.channel;
    database
      .prepare("DELETE FROM contact_identities WHERE contact_id = ? AND identity_value = ? COLLATE NOCASE")
      .run(contactId, row.normalized_platform_user_id);
    database
      .prepare(
        "DELETE FROM contact_identities WHERE contact_id = ? AND platform = ? AND identity_value = ? COLLATE NOCASE",
      )
      .run(contactId, legacyPlatform, row.platform_user_id);
  }

  database.prepare("DELETE FROM platform_identities WHERE id = ?").run(row.id);
  database
    .prepare(
      `
      INSERT OR IGNORE INTO identity_link_events (
        id, event_type, source_owner_type, source_owner_id, platform_identity_id,
        confidence, reason, actor_type, metadata_json
      )
      VALUES (?, 'unlink', 'contact', ?, ?, 1.0, ?, 'system', ?)
    `,
    )
    .run(
      stableId("ile", ["unlink", contactId, row.id, reason ?? "manual"]),
      contactId,
      row.id,
      reason ?? "manual",
      metadataJson({ source: "contacts_cli", channel: row.channel }),
    );

  if (!contactId) return null;
  syncContactProjection(database, contactId);
  return getContactDetails(contactId);
}

/**
 * Merge two contacts: move all identities from source to target, delete source
 */
export function mergeContacts(targetId: string, sourceId: string): { merged: number } {
  const database = ensureDb();
  const statements = getStatements();
  const target = getContactById(targetId);
  const source = getContactById(sourceId);
  if (!target) throw new Error(`Target contact not found: ${targetId}`);
  if (!source) throw new Error(`Source contact not found: ${sourceId}`);

  const sourceIdentities = getIdentitiesForContact(sourceId);
  let movedCanonicalIdentityIds: string[] = [];

  const txn = database.transaction(() => {
    // Move identities from source → target
    statements.moveIdentities.run(targetId, sourceId);
    movedCanonicalIdentityIds = moveCanonicalPlatformIdentities(database, sourceId, targetId);

    // Merge best data: prefer target, fill blanks from source
    const updates: string[] = [];
    const vals: (string | number | null)[] = [];

    if (!target.name && source.name) {
      updates.push("name = ?");
      vals.push(source.name);
    }
    if (!target.email && source.email) {
      updates.push("email = ?");
      vals.push(source.email);
    }
    if (target.tags.length === 0 && source.tags.length > 0) {
      updates.push("tags = ?");
      vals.push(JSON.stringify(source.tags));
    }
    if (Object.keys(target.notes).length === 0 && Object.keys(source.notes).length > 0) {
      updates.push("notes = ?");
      vals.push(JSON.stringify(source.notes));
    }
    // Sum interaction counts
    updates.push("interaction_count = interaction_count + ?");
    vals.push(source.interaction_count);

    if (updates.length > 0) {
      updates.push("updated_at = datetime('now')");
      vals.push(targetId);
      database.prepare(`UPDATE contacts_v2 SET ${updates.join(", ")} WHERE id = ?`).run(...vals);
    }

    // Delete source contact
    statements.deleteContact.run(sourceId);
    deleteContactProjection(database, sourceId);
    syncContactProjection(database, targetId);

    database
      .prepare(
        `
        INSERT OR IGNORE INTO identity_link_events (
          id, event_type, source_owner_type, source_owner_id, target_owner_type, target_owner_id,
          confidence, reason, actor_type, metadata_json
        )
        VALUES (?, 'merge', 'contact', ?, 'contact', ?, 1.0, 'legacy_merge', 'system', ?)
      `,
      )
      .run(
        stableId("ile", ["merge", sourceId, targetId, String(Date.now())]),
        sourceId,
        targetId,
        metadataJson({ movedIdentityCount: sourceIdentities.length, movedCanonicalIdentityIds }),
      );
  });

  txn();
  return { merged: sourceIdentities.length };
}

/**
 * Auto-link: when we discover that a phone and LID belong to the same person,
 * add the missing identity to the existing contact.
 * If both exist as separate contacts, merge them.
 */
export function autoLinkIdentities(phoneValue: string, lidValue: string): void {
  const normalizedPhone = normalizePhone(phoneValue);
  const normalizedLid = normalizePhone(lidValue);

  const phoneContact = resolveContact(normalizedPhone);
  const lidContact = resolveContact(normalizedLid);

  if (phoneContact && lidContact) {
    if (phoneContact.id === lidContact.id) return; // already same contact
    // Merge: prefer the one with more data (higher status priority)
    const statusPriority: Record<string, number> = { allowed: 3, pending: 2, discovered: 1, blocked: 0 };
    const phonePriority = statusPriority[phoneContact.status] ?? 0;
    const lidPriority = statusPriority[lidContact.status] ?? 0;
    if (phonePriority >= lidPriority) {
      mergeContacts(phoneContact.id, lidContact.id);
    } else {
      mergeContacts(lidContact.id, phoneContact.id);
    }
  } else if (phoneContact && !lidContact) {
    // Add LID identity to phone contact
    try {
      addContactIdentity(phoneContact.id, "whatsapp_lid", normalizedLid);
    } catch {
      /* already exists */
    }
  } else if (!phoneContact && lidContact) {
    // Add phone identity to LID contact
    try {
      addContactIdentity(lidContact.id, "phone", normalizedPhone);
    } catch {
      /* already exists */
    }
  }
  // If neither exists, nothing to link
}

// ============================================================================
// Group Tags — per-group tags stored in notes.groupTags
// ============================================================================

/**
 * Resolve a group reference to its contactId (UUID).
 * Accepts contactId, group identity, or any resolveContact-compatible ref.
 */
function resolveGroupIdentity(groupRef: string): string {
  const contact = resolveContact(groupRef);
  if (contact) return contact.id;
  return groupRef;
}

/**
 * Set a tag for a contact in a specific group.
 * Stored in notes.groupTags: { [groupContactId]: tag }
 * Both contactRef and groupRef accept contactId or identity.
 */
export function setGroupTag(contactRef: string, groupRef: string, tag: string): void {
  const contact = resolveContact(contactRef);
  if (!contact) throw new Error(`Contact not found: ${contactRef}`);

  const groupKey = resolveGroupIdentity(groupRef);
  const groupTags = (contact.notes.groupTags as Record<string, string>) ?? {};
  groupTags[groupKey] = tag;
  mergeContactNotes(contact.phone, { groupTags });
}

/**
 * Remove a contact's tag from a specific group.
 */
export function removeGroupTag(contactRef: string, groupRef: string): void {
  const database = ensureDb();
  const contact = resolveContact(contactRef);
  if (!contact) return;

  const groupKey = resolveGroupIdentity(groupRef);
  const groupTags = (contact.notes.groupTags as Record<string, string>) ?? {};
  delete groupTags[groupKey];
  database
    .prepare(
      "UPDATE contacts_v2 SET notes = json_set(notes, '$.groupTags', json(?)), updated_at = datetime('now') WHERE id = ?",
    )
    .run(JSON.stringify(groupTags), contact.id);
  syncContactProjection(database, contact.id);
}

/**
 * Get a contact's tag in a specific group.
 * Accepts contactId, phone, LID, or any resolveContact-compatible ref.
 */
export function getGroupTag(contactRef: string, groupRef: string): string | null {
  const contact = resolveContact(contactRef);
  if (!contact) return null;
  const groupKey = resolveGroupIdentity(groupRef);
  const groupTags = contact.notes.groupTags as Record<string, string> | undefined;
  return groupTags?.[groupKey] ?? null;
}

/**
 * Check if a contact is allowed for a specific agent.
 * Returns true if no restriction applies.
 */
export function isContactAllowedForAgent(phone: string, agentId: string): boolean {
  const contact = getContact(phone);
  if (!contact) return true;
  if (contact.status !== "allowed") return true;
  if (!contact.allowedAgents || contact.allowedAgents.length === 0) return true;
  return contact.allowedAgents.includes(agentId);
}

// ============================================================================
// Per-Account Pending
// ============================================================================

export interface AccountPendingEntry {
  accountId: string;
  phone: string;
  name: string | null;
  chatId: string | null;
  isGroup: boolean;
  pendingKind: "contact" | "chat";
  chatType: "dm" | "group";
  createdAt: number;
  updatedAt: number;
}

export interface AccountPendingListOptions {
  kind?: "contact" | "chat";
}

/**
 * Save a contact/chat as pending for a specific account (no route matched).
 * Upserts — safe to call multiple times.
 *
 * Compatibility note: this still writes the legacy account_pending table, but
 * callers must treat isGroup=true entries as chat/route review, not contacts.
 */
export function saveAccountPending(
  accountId: string,
  phone: string,
  opts?: { name?: string | null; chatId?: string; isGroup?: boolean },
): boolean {
  const database = ensureDb();
  const exists = database
    .prepare("SELECT 1 FROM account_pending WHERE account_id = ? AND phone = ?")
    .get(accountId, phone);
  const now = Date.now();
  database
    .prepare(`
    INSERT INTO account_pending (account_id, phone, name, chat_id, is_group, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, phone) DO UPDATE SET
      name = COALESCE(excluded.name, account_pending.name),
      chat_id = COALESCE(excluded.chat_id, account_pending.chat_id),
      is_group = excluded.is_group,
      updated_at = excluded.updated_at
  `)
    .run(accountId, phone, opts?.name ?? null, opts?.chatId ?? null, opts?.isGroup ? 1 : 0, now, now);
  return !exists;
}

/**
 * List pending account review entries for an account (or all accounts).
 */
export function listAccountPending(accountId?: string, options?: AccountPendingListOptions): AccountPendingEntry[] {
  const database = ensureDb();
  const rows = accountId
    ? database.prepare("SELECT * FROM account_pending WHERE account_id = ? ORDER BY updated_at DESC").all(accountId)
    : database.prepare("SELECT * FROM account_pending ORDER BY account_id, updated_at DESC").all();

  return (
    rows as Array<{
      account_id: string;
      phone: string;
      name: string | null;
      chat_id: string | null;
      is_group: number;
      created_at: number;
      updated_at: number;
    }>
  )
    .map((r) => {
      const isGroup = r.is_group === 1;
      return {
        accountId: r.account_id,
        phone: r.phone,
        name: r.name,
        chatId: r.chat_id,
        isGroup,
        pendingKind: isGroup ? ("chat" as const) : ("contact" as const),
        chatType: isGroup ? ("group" as const) : ("dm" as const),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    })
    .filter((entry) => !options?.kind || entry.pendingKind === options.kind);
}

export function listAccountPendingContacts(accountId?: string): AccountPendingEntry[] {
  return listAccountPending(accountId, { kind: "contact" });
}

export function listAccountPendingChats(accountId?: string): AccountPendingEntry[] {
  return listAccountPending(accountId, { kind: "chat" });
}

/**
 * Remove a contact from account pending (e.g., after adding a route).
 */
export function removeAccountPending(accountId: string, phone: string): boolean {
  const result = ensureDb()
    .prepare("DELETE FROM account_pending WHERE account_id = ? AND phone = ?")
    .run(accountId, phone);
  return result.changes > 0;
}

/**
 * Clear all pending for an account.
 */
export function clearAccountPending(accountId: string): number {
  const result = ensureDb().prepare("DELETE FROM account_pending WHERE account_id = ?").run(accountId);
  return result.changes;
}

export function closeContacts(): void {
  if (db !== null) {
    db.close();
    db = null;
    dbPath = null;
    stmts = null;
  }
}
