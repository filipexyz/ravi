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

// Initialize contacts schema
db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    phone TEXT PRIMARY KEY,
    name TEXT,
    status TEXT DEFAULT 'allowed' CHECK(status IN ('allowed', 'pending', 'blocked', 'discovered')),
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// Migrations
try {
  db.exec(`ALTER TABLE contacts ADD COLUMN status TEXT DEFAULT 'allowed'`);
} catch { /* exists */ }
try {
  db.exec(`UPDATE contacts SET status = CASE WHEN allowed = 1 THEN 'allowed' ELSE 'blocked' END WHERE status IS NULL`);
} catch { /* done */ }
try {
  db.exec(`ALTER TABLE contacts ADD COLUMN agent_id TEXT`);
} catch { /* exists */ }
try {
  db.exec(`ALTER TABLE contacts ADD COLUMN reply_mode TEXT DEFAULT 'auto'`);
} catch { /* exists */ }
try {
  db.exec(`ALTER TABLE contacts ADD COLUMN email TEXT`);
} catch { /* exists */ }
try {
  db.exec(`ALTER TABLE contacts ADD COLUMN tags TEXT`);
} catch { /* exists */ }
try {
  db.exec(`ALTER TABLE contacts ADD COLUMN notes TEXT`);
} catch { /* exists */ }
try {
  db.exec(`ALTER TABLE contacts ADD COLUMN opt_out INTEGER DEFAULT 0`);
} catch { /* exists */ }
try {
  db.exec(`ALTER TABLE contacts ADD COLUMN last_inbound_at TEXT`);
} catch { /* exists */ }
try {
  db.exec(`ALTER TABLE contacts ADD COLUMN last_outbound_at TEXT`);
} catch { /* exists */ }
try {
  db.exec(`ALTER TABLE contacts ADD COLUMN interaction_count INTEGER DEFAULT 0`);
} catch { /* exists */ }

export type ContactStatus = "allowed" | "pending" | "blocked" | "discovered";
export type ReplyMode = "auto" | "mention";

export interface Contact {
  phone: string;
  name: string | null;
  email: string | null;
  status: ContactStatus;
  agent_id: string | null;
  reply_mode: ReplyMode;
  tags: string[];
  notes: Record<string, unknown>;
  opt_out: boolean;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  interaction_count: number;
  created_at: string;
  updated_at: string;
}

// Row type matches raw SQLite shape
interface ContactRow {
  phone: string;
  name: string | null;
  email: string | null;
  status: string;
  agent_id: string | null;
  reply_mode: string | null;
  tags: string | null;
  notes: string | null;
  opt_out: number | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  interaction_count: number | null;
  created_at: string;
  updated_at: string;
}

function rowToContact(row: ContactRow): Contact {
  return {
    phone: row.phone,
    name: row.name,
    email: row.email ?? null,
    status: (row.status ?? "allowed") as ContactStatus,
    agent_id: row.agent_id,
    reply_mode: (row.reply_mode ?? "auto") as ReplyMode,
    tags: row.tags ? JSON.parse(row.tags) : [],
    notes: row.notes ? JSON.parse(row.notes) : {},
    opt_out: (row.opt_out ?? 0) === 1,
    last_inbound_at: row.last_inbound_at,
    last_outbound_at: row.last_outbound_at,
    interaction_count: row.interaction_count ?? 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// Prepared statements
const upsertStmt = db.prepare(`
  INSERT INTO contacts (phone, name, status, updated_at)
  VALUES (?, ?, ?, datetime('now'))
  ON CONFLICT(phone) DO UPDATE SET
    name = COALESCE(excluded.name, contacts.name),
    status = excluded.status,
    updated_at = datetime('now')
`);

const upsertNameOnlyStmt = db.prepare(`
  INSERT INTO contacts (phone, name, status, updated_at)
  VALUES (?, ?, 'pending', datetime('now'))
  ON CONFLICT(phone) DO UPDATE SET
    name = COALESCE(excluded.name, contacts.name),
    updated_at = datetime('now')
`);

const getContactStmt = db.prepare(
  "SELECT * FROM contacts WHERE phone = ?"
);

const getAllContactsStmt = db.prepare(
  "SELECT * FROM contacts ORDER BY status, name, phone"
);

const getContactsByStatusStmt = db.prepare(
  "SELECT * FROM contacts WHERE status = ? ORDER BY name, phone"
);

const deleteContactStmt = db.prepare(
  "DELETE FROM contacts WHERE phone = ?"
);

const setStatusStmt = db.prepare(
  "UPDATE contacts SET status = ?, agent_id = ?, updated_at = datetime('now') WHERE phone = ?"
);

/**
 * Add or update a contact with explicit status
 */
export function upsertContact(
  phone: string,
  name?: string | null,
  status: ContactStatus = "allowed"
): void {
  const normalizedPhone = normalizePhone(phone);
  upsertStmt.run(normalizedPhone, name ?? null, status);
}

/**
 * Save a pending contact (updates name but doesn't change status if exists)
 */
export function savePendingContact(phone: string, name?: string | null): void {
  const normalizedPhone = normalizePhone(phone);
  upsertNameOnlyStmt.run(normalizedPhone, name ?? null);
}

/**
 * Get a contact by phone
 */
export function getContact(phone: string): Contact | null {
  const normalizedPhone = normalizePhone(phone);
  const row = getContactStmt.get(normalizedPhone) as ContactRow | undefined;
  return row ? rowToContact(row) : null;
}

/**
 * Check if a phone is allowed
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
  return (getAllContactsStmt.all() as ContactRow[]).map(rowToContact);
}

/**
 * Get contacts by status
 */
export function getContactsByStatus(status: ContactStatus): Contact[] {
  return (getContactsByStatusStmt.all(status) as ContactRow[]).map(rowToContact);
}

/**
 * Get pending contacts
 */
export function getPendingContacts(): Contact[] {
  return getContactsByStatus("pending");
}

/**
 * Delete a contact
 */
export function deleteContact(phone: string): boolean {
  const normalizedPhone = normalizePhone(phone);
  deleteContactStmt.run(normalizedPhone);
  return (db as unknown as { changes: number }).changes > 0;
}

/**
 * Set contact status and optionally agent
 */
export function setContactStatus(phone: string, status: ContactStatus, agentId?: string): void {
  const normalizedPhone = normalizePhone(phone);
  const contact = getContact(normalizedPhone);
  if (!contact) {
    upsertContact(normalizedPhone, null, status);
    if (agentId) {
      setStatusStmt.run(status, agentId, normalizedPhone);
    }
  } else {
    setStatusStmt.run(status, agentId ?? contact.agent_id, normalizedPhone);
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
  return contact?.agent_id ?? null;
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
  const normalizedPhone = normalizePhone(phone);
  db.prepare(
    "UPDATE contacts SET reply_mode = ?, updated_at = datetime('now') WHERE phone = ?"
  ).run(mode, normalizedPhone);
}

/**
 * Block a contact
 */
export function blockContact(phone: string): void {
  setContactStatus(phone, "blocked");
}

/**
 * Get contact name by phone (returns null if not found or no name)
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
  const normalizedPhone = normalizePhone(phone);
  db.prepare(`
    INSERT INTO contacts (phone, name, status, updated_at)
    VALUES (?, ?, 'discovered', datetime('now'))
    ON CONFLICT(phone) DO UPDATE SET
      name = COALESCE(contacts.name, excluded.name),
      updated_at = datetime('now')
  `).run(normalizedPhone, name ?? null);
}

/**
 * Create a contact with extended fields
 */
export function createContact(input: {
  phone: string;
  name?: string;
  email?: string;
  status?: ContactStatus;
  tags?: string[];
  notes?: Record<string, unknown>;
}): Contact {
  const normalized = normalizePhone(input.phone);
  const existing = getContact(normalized);
  if (existing) {
    throw new Error(`Contact already exists: ${normalized}`);
  }

  db.prepare(`
    INSERT INTO contacts (phone, name, email, status, tags, notes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    normalized,
    input.name ?? null,
    input.email ?? null,
    input.status ?? "allowed",
    input.tags ? JSON.stringify(input.tags) : null,
    input.notes ? JSON.stringify(input.notes) : null,
  );

  return getContact(normalized)!;
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
  }
): Contact {
  const normalized = normalizePhone(phone);
  const contact = getContact(normalized);
  if (!contact) {
    throw new Error(`Contact not found: ${normalized}`);
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

  if (fields.length === 0) return contact;

  fields.push("updated_at = datetime('now')");
  values.push(normalized);

  db.prepare(`UPDATE contacts SET ${fields.join(", ")} WHERE phone = ?`).run(...values);
  return getContact(normalized)!;
}

/**
 * Find contacts by tag
 */
export function findContactsByTag(tag: string): Contact[] {
  const rows = db.prepare(
    `SELECT c.* FROM contacts c, json_each(c.tags) AS t WHERE t.value = ? ORDER BY c.name, c.phone`
  ).all(tag) as ContactRow[];
  return rows.map(rowToContact);
}

/**
 * Search contacts by name, phone, or email
 */
export function searchContacts(query: string): Contact[] {
  const pattern = `%${query}%`;
  const rows = db.prepare(
    `SELECT * FROM contacts WHERE phone LIKE ? OR name LIKE ? OR email LIKE ? ORDER BY name, phone`
  ).all(pattern, pattern, pattern) as ContactRow[];
  return rows.map(rowToContact);
}

/**
 * Merge notes into existing contact notes (shallow merge)
 */
export function mergeContactNotes(phone: string, newNotes: Record<string, unknown>): void {
  const normalized = normalizePhone(phone);
  const contact = getContact(normalized);
  if (!contact) {
    throw new Error(`Contact not found: ${normalized}`);
  }

  const merged = { ...contact.notes, ...newNotes };
  db.prepare(
    "UPDATE contacts SET notes = ?, updated_at = datetime('now') WHERE phone = ?"
  ).run(JSON.stringify(merged), normalized);
}

/**
 * Add a tag to a contact
 */
export function addContactTag(phone: string, tag: string): void {
  const normalized = normalizePhone(phone);
  const contact = getContact(normalized);
  if (!contact) {
    throw new Error(`Contact not found: ${normalized}`);
  }

  if (!contact.tags.includes(tag)) {
    const tags = [...contact.tags, tag];
    db.prepare(
      "UPDATE contacts SET tags = ?, updated_at = datetime('now') WHERE phone = ?"
    ).run(JSON.stringify(tags), normalized);
  }
}

/**
 * Remove a tag from a contact
 */
export function removeContactTag(phone: string, tag: string): void {
  const normalized = normalizePhone(phone);
  const contact = getContact(normalized);
  if (!contact) {
    throw new Error(`Contact not found: ${normalized}`);
  }

  const tags = contact.tags.filter(t => t !== tag);
  db.prepare(
    "UPDATE contacts SET tags = ?, updated_at = datetime('now') WHERE phone = ?"
  ).run(JSON.stringify(tags), normalized);
}

/**
 * Record an inbound message from a contact
 */
export function recordInbound(phone: string): void {
  const normalized = normalizePhone(phone);
  db.prepare(
    "UPDATE contacts SET last_inbound_at = datetime('now'), interaction_count = interaction_count + 1, updated_at = datetime('now') WHERE phone = ?"
  ).run(normalized);
}

/**
 * Record an outbound message to a contact
 */
export function recordOutbound(phone: string): void {
  const normalized = normalizePhone(phone);
  db.prepare(
    "UPDATE contacts SET last_outbound_at = datetime('now'), interaction_count = interaction_count + 1, updated_at = datetime('now') WHERE phone = ?"
  ).run(normalized);
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
  const normalized = normalizePhone(phone);
  db.prepare(
    "UPDATE contacts SET opt_out = ?, updated_at = datetime('now') WHERE phone = ?"
  ).run(optOut ? 1 : 0, normalized);
}

export function closeContacts(): void {
  db.close();
}
