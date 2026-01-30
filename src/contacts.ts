import Database from "better-sqlite3";
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
    status TEXT DEFAULT 'allowed' CHECK(status IN ('allowed', 'pending', 'blocked')),
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// Migrate old schema if needed (allowed INTEGER -> status TEXT)
try {
  db.exec(`ALTER TABLE contacts ADD COLUMN status TEXT DEFAULT 'allowed'`);
} catch {
  // Column already exists
}
try {
  // Migrate old data
  db.exec(`UPDATE contacts SET status = CASE WHEN allowed = 1 THEN 'allowed' ELSE 'blocked' END WHERE status IS NULL`);
} catch {
  // No migration needed
}

export type ContactStatus = "allowed" | "pending" | "blocked";

export interface Contact {
  phone: string;
  name: string | null;
  status: ContactStatus;
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
  "UPDATE contacts SET status = ?, updated_at = datetime('now') WHERE phone = ?"
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
  const result = deleteContactStmt.run(normalizedPhone);
  return result.changes > 0;
}

/**
 * Set contact status
 */
export function setContactStatus(phone: string, status: ContactStatus): void {
  const normalizedPhone = normalizePhone(phone);
  const contact = getContact(normalizedPhone);
  if (!contact) {
    upsertContact(normalizedPhone, null, status);
  } else {
    setStatusStmt.run(status, normalizedPhone);
  }
}

/**
 * Allow a contact
 */
export function allowContact(phone: string): void {
  setContactStatus(phone, "allowed");
}

/**
 * Block a contact
 */
export function blockContact(phone: string): void {
  setContactStatus(phone, "blocked");
}

export function closeContacts(): void {
  db.close();
}
