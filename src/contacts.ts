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

export type ContactStatus = "allowed" | "pending" | "blocked" | "discovered";
export type ReplyMode = "auto" | "mention";

export interface Contact {
  phone: string;
  name: string | null;
  status: ContactStatus;
  agent_id: string | null;
  reply_mode: ReplyMode;
  created_at: string;
  updated_at: string;
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
  const row = getContactStmt.get(normalizedPhone) as Contact | undefined;
  return row ?? null;
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
  return getAllContactsStmt.all() as Contact[];
}

/**
 * Get contacts by status
 */
export function getContactsByStatus(status: ContactStatus): Contact[] {
  return getContactsByStatusStmt.all(status) as Contact[];
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

export function closeContacts(): void {
  db.close();
}
