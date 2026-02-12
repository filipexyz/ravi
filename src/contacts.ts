import { Database } from "bun:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";

// Re-export normalize functions from channel module for backwards compatibility
export {
  normalizePhone,
  isGroup,
  formatPhone,
} from "./channels/whatsapp/normalize.js";

import { normalizePhone } from "./channels/whatsapp/normalize.js";

const DATA_DIR = join(homedir(), ".ravi");
const DB_PATH = join(DATA_DIR, "chat.db");

mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);

// WAL mode for concurrent read/write access (CLI + daemon)
db.exec("PRAGMA journal_mode = WAL");
// Wait up to 5s for locks to clear instead of failing immediately
db.exec("PRAGMA busy_timeout = 5000");
// Enable foreign keys
db.exec("PRAGMA foreign_keys = ON");

// ============================================================================
// Schema v2: contacts_v2 + contact_identities
// ============================================================================

db.exec(`
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

db.exec(`
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
  db.exec(`CREATE INDEX IF NOT EXISTS idx_identities_contact ON contact_identities(contact_id)`);
} catch { /* exists */ }

// ============================================================================
// Migration from old contacts table
// ============================================================================

function migrateFromV1(): void {
  // Check if old table exists
  const oldTable = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='contacts'"
  ).get() as { name: string } | undefined;

  if (!oldTable) return;

  // Check if already migrated (contacts_legacy exists)
  const legacyTable = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='contacts_legacy'"
  ).get() as { name: string } | undefined;

  if (legacyTable) return;

  // Check if v2 already has data (skip migration)
  const v2Count = (db.prepare("SELECT COUNT(*) as c FROM contacts_v2").get() as { c: number }).c;
  if (v2Count > 0) {
    // Already has v2 data, just rename old table
    db.exec("ALTER TABLE contacts RENAME TO contacts_legacy");
    return;
  }

  // Migrate each row
  const rows = db.prepare("SELECT * FROM contacts").all() as Array<Record<string, unknown>>;

  const insertContact = db.prepare(`
    INSERT INTO contacts_v2 (id, name, email, status, agent_id, reply_mode, tags, notes, opt_out, source, last_inbound_at, last_outbound_at, interaction_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertIdentity = db.prepare(`
    INSERT INTO contact_identities (contact_id, platform, identity_value, is_primary)
    VALUES (?, ?, ?, 1)
  `);

  const txn = db.transaction(() => {
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
        row.name ?? null,
        row.email ?? null,
        row.status ?? "allowed",
        row.agent_id ?? null,
        row.reply_mode ?? "auto",
        row.tags ?? null,
        row.notes ?? null,
        row.opt_out ?? 0,
        row.source ?? null,
        row.last_inbound_at ?? null,
        row.last_outbound_at ?? null,
        row.interaction_count ?? 0,
        row.created_at ?? null,
        row.updated_at ?? null,
      );

      insertIdentity.run(id, platform, phone);
    }

    // Rename old table as backup
    db.exec("ALTER TABLE contacts RENAME TO contacts_legacy");
  });

  txn();
}

migrateFromV1();

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

// ============================================================================
// Prepared Statements
// ============================================================================

const stmts = {
  getContactById: db.prepare("SELECT * FROM contacts_v2 WHERE id = ?"),
  getContactByIdentity: db.prepare(`
    SELECT c.* FROM contacts_v2 c
    JOIN contact_identities ci ON ci.contact_id = c.id
    WHERE ci.identity_value = ? COLLATE NOCASE
    LIMIT 1
  `),
  getIdentities: db.prepare("SELECT * FROM contact_identities WHERE contact_id = ? ORDER BY is_primary DESC, created_at"),
  getAllContacts: db.prepare("SELECT * FROM contacts_v2 ORDER BY status, name, id"),
  getContactsByStatus: db.prepare("SELECT * FROM contacts_v2 WHERE status = ? ORDER BY name, id"),
  deleteContact: db.prepare("DELETE FROM contacts_v2 WHERE id = ?"),
  deleteIdentity: db.prepare("DELETE FROM contact_identities WHERE platform = ? AND identity_value = ? COLLATE NOCASE"),
  insertContact: db.prepare(`
    INSERT INTO contacts_v2 (id, name, email, status, source, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `),
  insertIdentity: db.prepare(`
    INSERT INTO contact_identities (contact_id, platform, identity_value, is_primary)
    VALUES (?, ?, ?, ?)
  `),
  updateStatus: db.prepare("UPDATE contacts_v2 SET status = ?, agent_id = ?, updated_at = datetime('now') WHERE id = ?"),
  updateReplyMode: db.prepare("UPDATE contacts_v2 SET reply_mode = ?, updated_at = datetime('now') WHERE id = ?"),
  upsertPending: db.prepare(`
    INSERT INTO contacts_v2 (id, name, status, source, updated_at)
    VALUES (?, ?, 'pending', 'inbound', datetime('now'))
  `),
  recordInbound: db.prepare("UPDATE contacts_v2 SET last_inbound_at = datetime('now'), interaction_count = interaction_count + 1, updated_at = datetime('now') WHERE id = ?"),
  recordOutbound: db.prepare("UPDATE contacts_v2 SET last_outbound_at = datetime('now'), interaction_count = interaction_count + 1, updated_at = datetime('now') WHERE id = ?"),
  searchContacts: db.prepare(`
    SELECT DISTINCT c.* FROM contacts_v2 c
    LEFT JOIN contact_identities ci ON ci.contact_id = c.id
    WHERE c.name LIKE ? OR c.email LIKE ? OR ci.identity_value LIKE ?
    ORDER BY c.name, c.id
  `),
  findByTag: db.prepare(`
    SELECT c.* FROM contacts_v2 c, json_each(c.tags) AS t WHERE t.value = ? ORDER BY c.name, c.id
  `),
  getIdentityByValue: db.prepare("SELECT * FROM contact_identities WHERE identity_value = ? COLLATE NOCASE"),
  moveIdentities: db.prepare("UPDATE contact_identities SET contact_id = ? WHERE contact_id = ?"),
};

// ============================================================================
// Internal Helpers
// ============================================================================

function getIdentitiesForContact(contactId: string): ContactIdentity[] {
  const rows = stmts.getIdentities.all(contactId) as IdentityRow[];
  return rows.map(r => ({
    platform: r.platform,
    value: r.identity_value,
    isPrimary: r.is_primary === 1,
    createdAt: r.created_at,
  }));
}

function rowToContact(row: ContactV2Row): Contact {
  const identities = getIdentitiesForContact(row.id);
  // Primary identity value for backward compat (phone field)
  const primary = identities.find(i => i.isPrimary) ?? identities[0];
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
    identities,
    last_inbound_at: row.last_inbound_at,
    last_outbound_at: row.last_outbound_at,
    interaction_count: row.interaction_count ?? 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Detect platform from a normalized identity value */
function detectPlatform(identity: string): string {
  if (identity.startsWith("lid:")) return "whatsapp_lid";
  if (identity.startsWith("group:")) return "whatsapp_group";
  return "phone";
}

/** Resolve any identity string to a Contact (or null) */
function resolveContact(identity: string): Contact | null {
  const normalized = normalizePhone(identity);

  // Try by identity_value first
  const row = stmts.getContactByIdentity.get(normalized) as ContactV2Row | undefined;
  if (row) return rowToContact(row);

  // Try by contact ID directly (short UUID)
  const byId = stmts.getContactById.get(normalized) as ContactV2Row | undefined;
  if (byId) return rowToContact(byId);

  // Also try the raw input as ID (in case it's already an ID)
  if (identity !== normalized) {
    const byRawId = stmts.getContactById.get(identity) as ContactV2Row | undefined;
    if (byRawId) return rowToContact(byRawId);
  }

  // If input is pure digits, also try as LID (common case: LID passed without prefix)
  if (/^\d+$/.test(normalized) && !normalized.startsWith("lid:")) {
    const asLid = stmts.getContactByIdentity.get(`lid:${normalized}`) as ContactV2Row | undefined;
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
  const row = stmts.getContactById.get(id) as ContactV2Row | undefined;
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
  return (stmts.getAllContacts.all() as ContactV2Row[]).map(rowToContact);
}

/**
 * Get contacts by status
 */
export function getContactsByStatus(status: ContactStatus): Contact[] {
  return (stmts.getContactsByStatus.all(status) as ContactV2Row[]).map(rowToContact);
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
  source?: ContactSource | null
): void {
  const normalized = normalizePhone(phone);
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
    db.prepare(`UPDATE contacts_v2 SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  } else {
    // Create new
    const id = generateId();
    const platform = detectPlatform(normalized);
    stmts.insertContact.run(id, name ?? null, null, status, source ?? null);
    stmts.insertIdentity.run(id, platform, normalized, 1);
  }
}

/**
 * Save a pending contact (updates name but doesn't change status if exists)
 */
export function savePendingContact(phone: string, name?: string | null): void {
  const normalized = normalizePhone(phone);
  const existing = resolveContact(normalized);

  if (existing) {
    // Update name only, don't change status
    if (name) {
      db.prepare("UPDATE contacts_v2 SET name = COALESCE(name, ?), updated_at = datetime('now') WHERE id = ?")
        .run(name, existing.id);
    }
  } else {
    // Create new pending contact
    const id = generateId();
    const platform = detectPlatform(normalized);
    stmts.upsertPending.run(id, name ?? null);
    stmts.insertIdentity.run(id, platform, normalized, 1);
  }
}

/**
 * Delete a contact (by any identity or ID)
 */
export function deleteContact(phone: string): boolean {
  const contact = resolveContact(phone);
  if (!contact) return false;
  stmts.deleteContact.run(contact.id);
  return true;
}

/**
 * Set contact status and optionally agent
 */
export function setContactStatus(phone: string, status: ContactStatus, agentId?: string): void {
  const normalized = normalizePhone(phone);
  const contact = resolveContact(normalized);
  if (!contact) {
    upsertContact(normalized, null, status);
    if (agentId) {
      const created = resolveContact(normalized);
      if (created) stmts.updateStatus.run(status, agentId, created.id);
    }
  } else {
    stmts.updateStatus.run(status, agentId ?? contact.agent_id ?? null, contact.id);
  }
}

/**
 * Allow a contact with optional agent
 */
export function allowContact(phone: string, agentId?: string): void {
  setContactStatus(phone, "allowed", agentId);
}

/**
 * Get agent for a contact
 */
export function getContactAgent(phone: string): string | null {
  const contact = getContact(phone);
  return contact?.agent_id || null;
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
  const contact = resolveContact(phone);
  if (contact) {
    stmts.updateReplyMode.run(mode, contact.id);
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
  const normalized = normalizePhone(phone);
  const existing = resolveContact(normalized);

  if (existing) {
    // Update name only if not set
    if (name) {
      db.prepare("UPDATE contacts_v2 SET name = COALESCE(name, ?), updated_at = datetime('now') WHERE id = ?")
        .run(name, existing.id);
    }
  } else {
    const id = generateId();
    const platform = detectPlatform(normalized);
    db.prepare(`
      INSERT INTO contacts_v2 (id, name, status, source, updated_at)
      VALUES (?, ?, 'discovered', 'discovered', datetime('now'))
    `).run(id, name ?? null);
    stmts.insertIdentity.run(id, platform, normalized, 1);
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
  const normalized = normalizePhone(input.phone);
  const existing = resolveContact(normalized);
  if (existing) {
    throw new Error(`Contact already exists: ${normalized}`);
  }

  const id = generateId();
  const platform = detectPlatform(normalized);

  db.prepare(`
    INSERT INTO contacts_v2 (id, name, email, status, source, tags, notes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    id,
    input.name ?? null,
    input.email ?? null,
    input.status ?? "allowed",
    input.source ?? null,
    input.tags ? JSON.stringify(input.tags) : null,
    input.notes ? JSON.stringify(input.notes) : null,
  );

  stmts.insertIdentity.run(id, platform, normalized, 1);
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
    agent_id?: string | null;
    reply_mode?: ReplyMode;
    tags?: string[];
    notes?: Record<string, unknown>;
    opt_out?: boolean;
    source?: ContactSource | null;
  }
): Contact {
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
  if (updates.agent_id !== undefined) {
    fields.push("agent_id = ?");
    values.push(updates.agent_id);
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

  if (fields.length === 0) return contact;

  fields.push("updated_at = datetime('now')");
  values.push(contact.id);

  db.prepare(`UPDATE contacts_v2 SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getContactById(contact.id)!;
}

/**
 * Find contacts by tag
 */
export function findContactsByTag(tag: string): Contact[] {
  const rows = stmts.findByTag.all(tag) as ContactV2Row[];
  return rows.map(rowToContact);
}

/**
 * Search contacts by name, email, or any identity value
 */
export function searchContacts(query: string): Contact[] {
  const pattern = `%${query}%`;
  const rows = stmts.searchContacts.all(pattern, pattern, pattern) as ContactV2Row[];
  return rows.map(rowToContact);
}

/**
 * Merge notes into existing contact notes (shallow merge)
 */
export function mergeContactNotes(phone: string, newNotes: Record<string, unknown>): void {
  const contact = resolveContact(phone);
  if (!contact) {
    throw new Error(`Contact not found: ${phone}`);
  }

  const merged = { ...contact.notes, ...newNotes };
  db.prepare(
    "UPDATE contacts_v2 SET notes = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(JSON.stringify(merged), contact.id);
}

/**
 * Add a tag to a contact
 */
export function addContactTag(phone: string, tag: string): void {
  const contact = resolveContact(phone);
  if (!contact) {
    throw new Error(`Contact not found: ${phone}`);
  }

  if (!contact.tags.includes(tag)) {
    const tags = [...contact.tags, tag];
    db.prepare(
      "UPDATE contacts_v2 SET tags = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(JSON.stringify(tags), contact.id);
  }
}

/**
 * Remove a tag from a contact
 */
export function removeContactTag(phone: string, tag: string): void {
  const contact = resolveContact(phone);
  if (!contact) {
    throw new Error(`Contact not found: ${phone}`);
  }

  const tags = contact.tags.filter(t => t !== tag);
  db.prepare(
    "UPDATE contacts_v2 SET tags = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(JSON.stringify(tags), contact.id);
}

/**
 * Record an inbound message from a contact
 */
export function recordInbound(phone: string): void {
  const contact = resolveContact(phone);
  if (contact) {
    stmts.recordInbound.run(contact.id);
  }
}

/**
 * Record an outbound message to a contact
 */
export function recordOutbound(phone: string): void {
  const contact = resolveContact(phone);
  if (contact) {
    stmts.recordOutbound.run(contact.id);
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
  const contact = resolveContact(phone);
  if (contact) {
    db.prepare(
      "UPDATE contacts_v2 SET opt_out = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(optOut ? 1 : 0, contact.id);
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
  const normalized = normalizePhone(value);

  // Check if this identity already belongs to another contact
  const existing = stmts.getIdentityByValue.get(normalized) as IdentityRow | undefined;
  if (existing) {
    if (existing.contact_id === contactId) return; // already linked
    throw new Error(`Identity ${normalized} already belongs to contact ${existing.contact_id}`);
  }

  stmts.insertIdentity.run(contactId, platform, normalized, isPrimary ? 1 : 0);
}

/**
 * Remove an identity from a contact
 */
export function removeContactIdentity(platform: string, value: string): void {
  const normalized = normalizePhone(value);
  stmts.deleteIdentity.run(platform, normalized);
}

/**
 * Merge two contacts: move all identities from source to target, delete source
 */
export function mergeContacts(targetId: string, sourceId: string): { merged: number } {
  const target = getContactById(targetId);
  const source = getContactById(sourceId);
  if (!target) throw new Error(`Target contact not found: ${targetId}`);
  if (!source) throw new Error(`Source contact not found: ${sourceId}`);

  const sourceIdentities = getIdentitiesForContact(sourceId);

  const txn = db.transaction(() => {
    // Move identities from source → target
    stmts.moveIdentities.run(targetId, sourceId);

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
      db.prepare(`UPDATE contacts_v2 SET ${updates.join(", ")} WHERE id = ?`).run(...vals);
    }

    // Delete source contact
    stmts.deleteContact.run(sourceId);
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
    } catch { /* already exists */ }
  } else if (!phoneContact && lidContact) {
    // Add phone identity to LID contact
    try {
      addContactIdentity(lidContact.id, "phone", normalizedPhone);
    } catch { /* already exists */ }
  }
  // If neither exists, nothing to link
}

export function closeContacts(): void {
  db.close();
}
