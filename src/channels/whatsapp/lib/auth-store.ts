/**
 * SQLite storage for the WhatsApp (Baileys) auth state.
 *
 * The auth state lives in its own database file, `<RAVI_STATE_DIR>/whatsapp/auth.db`,
 * not in ravi's shared router DB: daemon or CLI write locks on `ravi.db` can no
 * longer stall the runner or lose signal keys, and the file holds the linked
 * device's private keys, so the directory is 0700 and the files 0600. Only the
 * channel runner (and explicit CLI helpers such as `clearWhatsAppAuthState`) open it.
 *
 *   whatsapp_auth_state(instance_id, key, value, updated_at, PRIMARY KEY(instance_id, key))
 *   whatsapp_instance_state(instance_id PRIMARY KEY, manual_disconnect_at)
 *   whatsapp_auth_meta(key PRIMARY KEY, value)
 *
 * auth.ts addresses entries as `auth:<instanceId>:creds` and
 * `auth:<instanceId>:keys:<type>:<id>`; this store splits that into
 * `instance_id = <instanceId>` and `key = creds | keys:<type>:<id>`.
 *
 * Values are stored as text. auth.ts always writes strings produced by Baileys'
 * `BufferJSON.replacer`, and they are returned unchanged, so Buffers round-trip
 * exactly as with `useMultiFileAuthState`. A non-string value is encoded with the
 * same encoding before it is stored. The module has no runtime `baileys` import.
 *
 * The file runs in WAL mode with a short `busy_timeout` (250 ms); a call that still
 * finds the database locked is retried asynchronously (jittered sleeps, the event
 * loop is never blocked between attempts) before it fails. auth.ts keeps failed
 * writes dirty and retries them.
 *
 * On first open, rows of the old router-DB table (`whatsapp_auth_state` in
 * `ravi.db`, used before this file existed) are copied once; the old table is never
 * read or written again (marker `router_db_copy_v1` in `whatsapp_auth_meta`).
 */

import { Database } from "bun:sqlite";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { getDb } from "../../../router/router-db.js";
import { getRaviStateDir } from "../../../utils/paths.js";
import { type AuthStorageWrite, type PluginStorage, createLogger } from "./foundation.js";

const log = createLogger("whatsapp:auth-store");

export const WHATSAPP_AUTH_STATE_TABLE = "whatsapp_auth_state" as const;
export const WHATSAPP_INSTANCE_STATE_TABLE = "whatsapp_instance_state" as const;
export const WHATSAPP_AUTH_META_TABLE = "whatsapp_auth_meta" as const;
/** `whatsapp_auth_meta` key set once the router-DB rows were copied. */
export const WHATSAPP_AUTH_ROUTER_COPY_MARKER = "router_db_copy_v1" as const;
export const WHATSAPP_AUTH_DB_FILE_MODE = 0o600;
export const WHATSAPP_AUTH_DB_DIR_MODE = 0o700;
export const WHATSAPP_AUTH_DB_BUSY_TIMEOUT_MS = 250;

const AUTH_KEY_PREFIX = "auth:";
const CREDS_KEY = "creds";
const DEFAULT_LOCK_RETRIES = 4;
const DEFAULT_LOCK_RETRY_MIN_MS = 25;
const DEFAULT_LOCK_RETRY_MAX_MS = 150;

type DatabaseProvider = () => Database;

/** `<RAVI_STATE_DIR>/whatsapp/auth.db`. */
export function whatsappAuthDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getRaviStateDir(env), "whatsapp", "auth.db");
}

const initializedDatabases = new WeakSet<Database>();
const openDatabases = new Map<string, Database>();

/** Create the auth tables if they do not exist yet (once per database handle). */
export function ensureWhatsAppAuthStateSchema(db: Database): void {
  if (initializedDatabases.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${WHATSAPP_AUTH_STATE_TABLE} (
      instance_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (instance_id, key)
    );
    CREATE TABLE IF NOT EXISTS ${WHATSAPP_INSTANCE_STATE_TABLE} (
      instance_id TEXT PRIMARY KEY,
      manual_disconnect_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS ${WHATSAPP_AUTH_META_TABLE} (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  initializedDatabases.add(db);
}

function restrictMode(path: string, mode: number): void {
  try {
    if (existsSync(path)) chmodSync(path, mode);
  } catch (error) {
    log.warn("Could not restrict WhatsApp auth file permissions", { path, error: String(error) });
  }
}

export interface OpenWhatsAppAuthDbOptions {
  /** Router DB holding the pre-auth.db table to copy once. Default `getDb()`; null skips the copy. */
  legacyDb?: (() => Database) | null;
}

/**
 * Open (or return the already open handle of) the auth database at `path`:
 * directory 0700, files 0600, WAL, busy_timeout, schema, one-time router-DB copy.
 */
export function openWhatsAppAuthDb(
  path: string = whatsappAuthDbPath(),
  options: OpenWhatsAppAuthDbOptions = {},
): Database {
  const existing = openDatabases.get(path);
  if (existing) return existing;
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: WHATSAPP_AUTH_DB_DIR_MODE });
  restrictMode(dir, WHATSAPP_AUTH_DB_DIR_MODE);
  // Create the file with 0600 before SQLite opens it; SQLite gives -wal/-shm the same mode.
  closeSync(openSync(path, "a", WHATSAPP_AUTH_DB_FILE_MODE));
  restrictMode(path, WHATSAPP_AUTH_DB_FILE_MODE);
  const db = new Database(path, { create: true });
  db.exec(`PRAGMA busy_timeout = ${WHATSAPP_AUTH_DB_BUSY_TIMEOUT_MS}`);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  restrictMode(`${path}-wal`, WHATSAPP_AUTH_DB_FILE_MODE);
  restrictMode(`${path}-shm`, WHATSAPP_AUTH_DB_FILE_MODE);
  ensureWhatsAppAuthStateSchema(db);
  copyRouterDbAuthStateOnce(db, options.legacyDb === undefined ? () => getDb() : options.legacyDb);
  openDatabases.set(path, db);
  return db;
}

/** Close every auth database this process opened (tests, CLI teardown). */
export function closeWhatsAppAuthDbs(): void {
  for (const db of openDatabases.values()) {
    try {
      db.close();
    } catch {
      // Already closed.
    }
  }
  openDatabases.clear();
}

/**
 * Copy the rows of the router DB's `whatsapp_auth_state` table (if it exists) into
 * `db`, once. Rows already in `db` win. A failure to read the router DB leaves the
 * marker unset so the next open tries again; the old table is never modified.
 * Returns the number of copied rows.
 */
export function copyRouterDbAuthStateOnce(db: Database, legacyDb: (() => Database) | null): number {
  ensureWhatsAppAuthStateSchema(db);
  const done = () =>
    db.prepare(`SELECT 1 FROM ${WHATSAPP_AUTH_META_TABLE} WHERE key = ?`).get(WHATSAPP_AUTH_ROUTER_COPY_MARKER) !==
    null;
  if (done()) return 0;
  let rows: Array<{ instance_id: string; key: string; value: string; updated_at: number }> = [];
  if (legacyDb) {
    try {
      const source = legacyDb();
      const table = source
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(WHATSAPP_AUTH_STATE_TABLE);
      if (table) {
        rows = source
          .prepare(`SELECT instance_id, key, value, updated_at FROM ${WHATSAPP_AUTH_STATE_TABLE}`)
          .all() as typeof rows;
      }
    } catch (error) {
      log.warn("Could not read the router DB WhatsApp auth rows; the copy is retried on the next open", {
        error: String(error),
      });
      return 0;
    }
  }
  let copied = 0;
  db.transaction(() => {
    if (done()) return;
    const insert = db.prepare(
      `INSERT OR IGNORE INTO ${WHATSAPP_AUTH_STATE_TABLE} (instance_id, key, value, updated_at) VALUES (?, ?, ?, ?)`,
    );
    for (const row of rows) copied += insert.run(row.instance_id, row.key, row.value, row.updated_at).changes;
    db.prepare(`INSERT OR REPLACE INTO ${WHATSAPP_AUTH_META_TABLE} (key, value) VALUES (?, ?)`).run(
      WHATSAPP_AUTH_ROUTER_COPY_MARKER,
      String(Date.now()),
    );
  }).immediate();
  if (copied > 0) log.info("Copied WhatsApp auth rows from the router DB", { rows: copied });
  return copied;
}

interface ParsedAuthKey {
  instanceId: string;
  key: string;
}

/** Split `auth:<instanceId>:<rest>` into its row coordinates. */
export function parseWhatsAppAuthKey(storageKey: string): ParsedAuthKey {
  if (!storageKey.startsWith(AUTH_KEY_PREFIX)) {
    throw new Error(`WhatsApp auth storage key must start with "${AUTH_KEY_PREFIX}": ${storageKey}`);
  }
  const rest = storageKey.slice(AUTH_KEY_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator <= 0 || separator === rest.length - 1) {
    throw new Error(`WhatsApp auth storage key must look like auth:<instanceId>:<key>: ${storageKey}`);
  }
  return { instanceId: rest.slice(0, separator), key: rest.slice(separator + 1) };
}

function formatAuthKey(instanceId: string, key: string): string {
  return `${AUTH_KEY_PREFIX}${instanceId}:${key}`;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** The instance id a glob pattern is pinned to, when its `auth:<id>:` prefix has no wildcard. */
function patternInstanceId(pattern: string): string | null {
  if (!pattern.startsWith(AUTH_KEY_PREFIX)) return null;
  const rest = pattern.slice(AUTH_KEY_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator <= 0) return null;
  const instanceId = rest.slice(0, separator);
  return instanceId.includes("*") ? null : instanceId;
}

/**
 * Same encoding as Baileys' `BufferJSON.replacer`, inlined so this module stays
 * free of a runtime `baileys` import (driver health and CLI code can use it
 * without loading Baileys).
 */
function bufferJsonReplacer(_key: string, value: unknown): unknown {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { type: "Buffer", data: Buffer.from(value).toString("base64") };
  }
  if (value && typeof value === "object" && (value as { type?: unknown }).type === "Buffer") {
    const data = (value as { data?: unknown }).data;
    if (Array.isArray(data)) return { type: "Buffer", data: Buffer.from(data as number[]).toString("base64") };
    if (typeof data === "string") return value;
  }
  return value;
}

function encodeValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, bufferJsonReplacer);
}

/** SQLITE_BUSY / SQLITE_LOCKED. */
export function isWhatsAppAuthDbLockError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("database is locked") || message.includes("busy") || message.includes("sqlite_locked");
}

export interface SqliteWhatsAppAuthStorageOptions {
  /** Database handle provider. Default: `openWhatsAppAuthDb(path)`, resolved per call. */
  db?: DatabaseProvider;
  /** Auth database file. Default `whatsappAuthDbPath()` (read when the default provider first opens it). */
  path?: string;
  now?: () => number;
  /** Extra attempts after a lock error (default 4). */
  lockRetries?: number;
  /** Async sleep between lock retries (default: a jittered 25-150 ms timer). */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * `PluginStorage` over `auth.db`. Statements are synchronous bun:sqlite calls; a
 * lock error is retried after an async sleep so the runner's event loop keeps going.
 */
export class SqliteWhatsAppAuthStorage implements PluginStorage {
  private readonly dbProvider: DatabaseProvider;
  private readonly now: () => number;
  private readonly lockRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: SqliteWhatsAppAuthStorageOptions = {}) {
    this.dbProvider = options.db ?? (() => openWhatsAppAuthDb(options.path ?? whatsappAuthDbPath()));
    this.now = options.now ?? Date.now;
    this.lockRetries = Math.max(0, options.lockRetries ?? DEFAULT_LOCK_RETRIES);
    this.sleep = options.sleep ?? defaultSleep;
  }

  private db(): Database {
    const db = this.dbProvider();
    ensureWhatsAppAuthStateSchema(db);
    return db;
  }

  /** Run `fn`; on a lock error sleep (async, jittered) and try again, up to `lockRetries` times. */
  private async withLockRetry<T>(fn: (db: Database) => T): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return fn(this.db());
      } catch (error) {
        if (!isWhatsAppAuthDbLockError(error) || attempt >= this.lockRetries) throw error;
        const delay =
          DEFAULT_LOCK_RETRY_MIN_MS + Math.random() * (DEFAULT_LOCK_RETRY_MAX_MS - DEFAULT_LOCK_RETRY_MIN_MS);
        await this.sleep(Math.round(delay));
      }
    }
  }

  /** Raw stored text for one entry, or null. */
  getText(instanceId: string, key: string): string | null {
    const row = this.db()
      .prepare(`SELECT value FROM ${WHATSAPP_AUTH_STATE_TABLE} WHERE instance_id = ? AND key = ?`)
      .get(instanceId, key) as { value: string } | null;
    return row?.value ?? null;
  }

  async get<T>(storageKey: string): Promise<T | null> {
    const { instanceId, key } = parseWhatsAppAuthKey(storageKey);
    return (await this.withLockRetry(() => this.getText(instanceId, key))) as T | null;
  }

  async set<T>(storageKey: string, value: T, _ttlMs?: number): Promise<void> {
    await this.writeMany([{ key: storageKey, value: encodeValue(value) }]);
  }

  async delete(storageKey: string): Promise<boolean> {
    const { instanceId, key } = parseWhatsAppAuthKey(storageKey);
    const result = await this.withLockRetry((db) =>
      db.prepare(`DELETE FROM ${WHATSAPP_AUTH_STATE_TABLE} WHERE instance_id = ? AND key = ?`).run(instanceId, key),
    );
    return result.changes > 0;
  }

  async has(storageKey: string): Promise<boolean> {
    return (await this.get(storageKey)) !== null;
  }

  /** Apply every write (value null = delete) in ONE `BEGIN IMMEDIATE` transaction. */
  async writeMany(writes: readonly AuthStorageWrite[]): Promise<void> {
    if (writes.length === 0) return;
    const rows = writes.map((write) => ({ ...parseWhatsAppAuthKey(write.key), value: write.value }));
    await this.withLockRetry((db) => {
      const upsert = db.prepare(
        `INSERT INTO ${WHATSAPP_AUTH_STATE_TABLE} (instance_id, key, value, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(instance_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      );
      const remove = db.prepare(`DELETE FROM ${WHATSAPP_AUTH_STATE_TABLE} WHERE instance_id = ? AND key = ?`);
      const now = this.now();
      db.transaction(() => {
        for (const row of rows) {
          if (row.value === null) remove.run(row.instanceId, row.key);
          else upsert.run(row.instanceId, row.key, encodeValue(row.value), now);
        }
      }).immediate();
    });
  }

  async keys(pattern = "*"): Promise<string[]> {
    const instanceId = patternInstanceId(pattern);
    const rows = await this.withLockRetry(
      (db) =>
        (instanceId === null
          ? db.prepare(`SELECT instance_id, key FROM ${WHATSAPP_AUTH_STATE_TABLE}`).all()
          : db
              .prepare(`SELECT instance_id, key FROM ${WHATSAPP_AUTH_STATE_TABLE} WHERE instance_id = ?`)
              .all(instanceId)) as Array<{ instance_id: string; key: string }>,
    );
    const matcher = globToRegExp(pattern);
    return rows.map((row) => formatAuthKey(row.instance_id, row.key)).filter((key) => matcher.test(key));
  }

  /** Delete every auth row (creds and signal keys) of one instance. Returns the row count. */
  clear(instanceId: string): number {
    return this.db().prepare(`DELETE FROM ${WHATSAPP_AUTH_STATE_TABLE} WHERE instance_id = ?`).run(instanceId).changes;
  }

  /** True when the instance has stored creds that completed pairing (`creds.me.id` is set). */
  hasRegisteredCreds(instanceId: string): boolean {
    const text = this.getText(instanceId, CREDS_KEY);
    if (!text) return false;
    try {
      const creds = JSON.parse(text) as { me?: { id?: unknown } | null };
      return typeof creds.me?.id === "string" && creds.me.id.length > 0;
    } catch {
      return false;
    }
  }

  /** True when `connection.disconnect` was the last word for this instance (cleared by `connection.connect`). */
  isManuallyDisconnected(instanceId: string): boolean {
    const row = this.db()
      .prepare(`SELECT manual_disconnect_at FROM ${WHATSAPP_INSTANCE_STATE_TABLE} WHERE instance_id = ?`)
      .get(instanceId) as { manual_disconnect_at: number | null } | null;
    return typeof row?.manual_disconnect_at === "number";
  }

  /** Persist (or clear) the manual-disconnect marker of one instance. */
  setManuallyDisconnected(instanceId: string, disconnected: boolean): void {
    this.db()
      .prepare(
        `INSERT INTO ${WHATSAPP_INSTANCE_STATE_TABLE} (instance_id, manual_disconnect_at) VALUES (?, ?)
         ON CONFLICT(instance_id) DO UPDATE SET manual_disconnect_at = excluded.manual_disconnect_at`,
      )
      .run(instanceId, disconnected ? this.now() : null);
  }
}

/** Default store over `auth.db`. */
export function createWhatsAppAuthStorage(options?: SqliteWhatsAppAuthStorageOptions): SqliteWhatsAppAuthStorage {
  return new SqliteWhatsAppAuthStorage(options);
}

/** Delete all persisted auth state of one instance (creds, signal keys, manual-disconnect marker). */
export function clearWhatsAppAuthState(instanceId: string, options?: SqliteWhatsAppAuthStorageOptions): number {
  const storage = new SqliteWhatsAppAuthStorage(options);
  storage.setManuallyDisconnected(instanceId, false);
  return storage.clear(instanceId);
}

/** True when the instance has paired creds in `auth.db`. */
export function hasWhatsAppAuthCreds(instanceId: string, options?: SqliteWhatsAppAuthStorageOptions): boolean {
  return new SqliteWhatsAppAuthStorage(options).hasRegisteredCreds(instanceId);
}

/** True when the instance's last lifecycle command was `connection.disconnect`. */
export function isWhatsAppManuallyDisconnected(
  instanceId: string,
  options?: SqliteWhatsAppAuthStorageOptions,
): boolean {
  return new SqliteWhatsAppAuthStorage(options).isManuallyDisconnected(instanceId);
}
