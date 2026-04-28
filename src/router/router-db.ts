/**
 * Router Database - SQLite-backed configuration storage
 *
 * Stores agents, routes, and settings in SQLite to prevent
 * direct file editing by bots (which could bypass validation).
 *
 * Uses lazy initialization - database is only created when first accessed.
 */

import { Database, type Statement } from "bun:sqlite";
import { z } from "zod";
import { join } from "node:path";
import { mkdirSync, existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { logger } from "../utils/logger.js";
import { getRaviStateDir } from "../utils/paths.js";
import { normalizePhone } from "../utils/phone.js";
import type { AgentConfig, RouteConfig, DmScope } from "./types.js";

const log = logger.child("router:db");

// ============================================================================
// Constants
// ============================================================================

const RAVI_DIR = join(homedir(), "ravi");
const DEFAULT_RAVI_STATE_DIR = getRaviStateDir({});
const DEFAULT_DB_PATH = join(DEFAULT_RAVI_STATE_DIR, "ravi.db");
const LEGACY_DB_PATH = join(RAVI_DIR, "ravi.db");
const IDENTITY_CHAT_BACKFILL_KEY = "identity_chat_backfill_v1";

// ============================================================================
// Schemas (safe to access at import time - no I/O)
// ============================================================================

export const DmScopeSchema = z.enum(["main", "per-peer", "per-channel-peer", "per-account-channel-peer"]);

export const AgentModeSchema = z.enum(["active", "sentinel"]);
export const RuntimeProviderSchema = z.string().min(1);

export const AgentInputSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  cwd: z.string().min(1),
  model: z.string().optional(),
  provider: RuntimeProviderSchema.optional(),
  remote: z.string().optional(),
  remoteUser: z.string().optional(),
  dmScope: DmScopeSchema.optional(),
  systemPromptAppend: z.string().optional(),
  debounceMs: z.number().int().min(0).optional(),
  groupDebounceMs: z.number().int().min(0).optional(),
  matrixAccount: z.string().optional(),
  settingSources: z.array(z.enum(["user", "project"])).optional(),
  mode: AgentModeSchema.optional(),
});

export const RouteInputSchema = z.object({
  pattern: z.string().min(1),
  accountId: z.string().min(1),
  agent: z.string().min(1),
  dmScope: DmScopeSchema.optional(),
  session: z.string().optional(),
  priority: z.number().int().default(0),
  policy: z.string().optional(),
  channel: z.string().optional(),
});

export const GroupPolicySchema = z.enum(["open", "allowlist", "closed"]);
export const DmPolicySchema = z.enum(["open", "pairing", "closed"]);
export const ContextSourceSchema = z.object({
  channel: z.string().min(1),
  accountId: z.string().min(1),
  chatId: z.string().min(1),
  threadId: z.string().min(1).optional(),
});
export const ContextCapabilitySchema = z.object({
  permission: z.string().min(1),
  objectType: z.string().min(1),
  objectId: z.string().min(1),
  source: z.string().optional(),
});
export const ContextInputSchema = z.object({
  contextId: z.string().min(1),
  contextKey: z.string().min(1),
  kind: z.string().min(1).default("runtime"),
  agentId: z.string().min(1).optional(),
  sessionKey: z.string().min(1).optional(),
  sessionName: z.string().min(1).optional(),
  source: ContextSourceSchema.optional(),
  capabilities: z.array(ContextCapabilitySchema).default([]),
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.number().int().optional(),
  expiresAt: z.number().int().optional(),
  lastUsedAt: z.number().int().optional(),
  revokedAt: z.number().int().optional(),
});

export const InstanceInputSchema = z.object({
  name: z.string().min(1),
  instanceId: z.string().optional(),
  channel: z.string().default("whatsapp"),
  agent: z.string().optional(),
  dmPolicy: DmPolicySchema.default("open"),
  groupPolicy: GroupPolicySchema.default("open"),
  dmScope: DmScopeSchema.optional(),
  enabled: z.boolean().default(true),
  defaults: z.record(z.string(), z.unknown()).optional(),
});

// ============================================================================
// Row Types
// ============================================================================

interface AgentRow {
  id: string;
  name: string | null;
  cwd: string;
  model: string | null;
  provider: string | null;
  remote: string | null;
  remote_user: string | null;
  dm_scope: string | null;
  system_prompt_append: string | null;
  debounce_ms: number | null;
  group_debounce_ms: number | null;
  matrix_account: string | null;
  setting_sources: string | null;
  // Heartbeat columns
  heartbeat_enabled: number;
  heartbeat_interval_ms: number;
  heartbeat_model: string | null;
  heartbeat_active_start: string | null;
  heartbeat_active_end: string | null;
  heartbeat_last_run_at: number | null;
  heartbeat_account_id: string | null;
  // Scope isolation columns
  spec_mode: number;
  contact_scope: string | null;
  allowed_sessions: string | null;
  // Agent mode
  agent_mode: string | null;
  // Generic defaults
  defaults: string | null;
  created_at: number;
  updated_at: number;
}

interface RouteRow {
  id: number;
  pattern: string;
  account_id: string;
  agent_id: string;
  dm_scope: string | null;
  session_name: string | null;
  policy: string | null;
  priority: number;
  channel: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

interface InstanceRow {
  name: string;
  instance_id: string | null;
  channel: string;
  agent: string | null;
  dm_policy: string;
  group_policy: string;
  dm_scope: string | null;
  enabled: number | null;
  defaults: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

interface ContextRow {
  context_id: string;
  context_key: string;
  kind: string;
  agent_id: string | null;
  session_key: string | null;
  session_name: string | null;
  source_json: string | null;
  capabilities_json: string;
  metadata_json: string | null;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
}

interface ChatRow {
  id: string;
  channel: string;
  instance_id: string;
  platform_chat_id: string;
  normalized_chat_id: string;
  chat_type: string;
  title: string | null;
  avatar_url: string | null;
  metadata_json: string | null;
  raw_provenance_json: string | null;
  first_seen_at: number;
  last_seen_at: number;
  created_at: number;
  updated_at: number;
}

interface ChatParticipantRow {
  id: string;
  chat_id: string;
  platform_identity_id: string | null;
  contact_id: string | null;
  agent_id: string | null;
  raw_platform_user_id: string | null;
  normalized_platform_user_id: string | null;
  role: string;
  status: string;
  source: string;
  first_seen_at: number;
  last_seen_at: number;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

interface SessionChatBindingRow {
  session_key: string;
  chat_id: string;
  agent_id: string | null;
  route_id: number | null;
  binding_reason: string | null;
  created_at: number;
  updated_at: number;
}

interface SessionParticipantRow {
  id: string;
  session_key: string;
  owner_type: string;
  owner_id: string | null;
  platform_identity_id: string | null;
  role: string;
  first_seen_at: number;
  last_seen_at: number;
  message_count: number;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

export interface InstanceConfig {
  name: string;
  instanceId?: string;
  channel: string;
  agent?: string;
  dmPolicy: "open" | "pairing" | "closed";
  groupPolicy: "open" | "allowlist" | "closed";
  dmScope?: DmScope;
  enabled?: boolean;
  defaults?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

interface SettingRow {
  key: string;
  value: string;
  updated_at: number;
}

interface MatrixAccountRow {
  username: string;
  user_id: string;
  homeserver: string;
  access_token: string;
  device_id: string | null;
  created_at: number;
  last_used_at: number | null;
}

export interface MatrixAccount {
  username: string;
  userId: string;
  homeserver: string;
  accessToken: string;
  deviceId?: string;
  createdAt: number;
  lastUsedAt?: number;
}

export interface ContextSource {
  channel: string;
  accountId: string;
  chatId: string;
  threadId?: string;
}

export interface ContextCapability {
  permission: string;
  objectType: string;
  objectId: string;
  source?: string;
}

export interface ContextRecord {
  contextId: string;
  contextKey: string;
  kind: string;
  agentId?: string;
  sessionKey?: string;
  sessionName?: string;
  source?: ContextSource;
  capabilities: ContextCapability[];
  metadata?: Record<string, unknown>;
  createdAt: number;
  expiresAt?: number;
  lastUsedAt?: number;
  revokedAt?: number;
}

export type ChatType = "dm" | "group" | "room" | "thread" | "channel" | "unknown";
export type ChatParticipantType = "contact" | "agent" | "raw";
export type ChatParticipantRole = "member" | "admin" | "owner" | "agent" | "unknown" | (string & {});
export type ChatParticipantStatus = "active" | "left" | "removed" | "unknown" | (string & {});
export type ChatParticipantSource = "omni" | "inbound_message" | "manual" | "import" | "backfill" | (string & {});
export type SessionParticipantOwnerType = "contact" | "agent" | "unknown";
export type SessionParticipantRole = "human" | "agent" | "system" | "observer" | "unknown" | (string & {});

export interface ChatRecord {
  id: string;
  channel: string;
  instanceId: string;
  platformChatId: string;
  normalizedChatId: string;
  chatType: ChatType;
  title?: string;
  avatarUrl?: string;
  metadata?: Record<string, unknown>;
  rawProvenance?: Record<string, unknown>;
  firstSeenAt: number;
  lastSeenAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface UpsertChatInput {
  channel: string;
  instanceId?: string | null;
  platformChatId: string;
  normalizedChatId?: string | null;
  chatType?: ChatType;
  title?: string | null;
  avatarUrl?: string | null;
  metadata?: Record<string, unknown> | null;
  rawProvenance?: Record<string, unknown> | null;
  seenAt?: number;
}

export interface ChatParticipantRecord {
  id: string;
  chatId: string;
  participantType: ChatParticipantType;
  platformIdentityId?: string;
  contactId?: string;
  agentId?: string;
  rawPlatformUserId?: string;
  normalizedPlatformUserId?: string;
  role: ChatParticipantRole;
  status: ChatParticipantStatus;
  source: ChatParticipantSource;
  firstSeenAt: number;
  lastSeenAt: number;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface UpsertChatParticipantInput {
  chatId: string;
  platformIdentityId?: string | null;
  contactId?: string | null;
  agentId?: string | null;
  rawPlatformUserId?: string | null;
  normalizedPlatformUserId?: string | null;
  role?: ChatParticipantRole | null;
  status?: ChatParticipantStatus | null;
  source?: ChatParticipantSource | null;
  metadata?: Record<string, unknown> | null;
  seenAt?: number;
}

export interface SessionChatBindingRecord {
  sessionKey: string;
  chatId: string;
  agentId?: string;
  routeId?: number;
  bindingReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionParticipantRecord {
  id: string;
  sessionKey: string;
  ownerType: SessionParticipantOwnerType;
  ownerId?: string;
  platformIdentityId?: string;
  role: SessionParticipantRole;
  firstSeenAt: number;
  lastSeenAt: number;
  messageCount: number;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface UpsertSessionParticipantInput {
  sessionKey: string;
  ownerType?: SessionParticipantOwnerType | null;
  ownerId?: string | null;
  platformIdentityId?: string | null;
  role?: SessionParticipantRole | null;
  metadata?: Record<string, unknown> | null;
  incrementMessageCount?: boolean;
  seenAt?: number;
}

export interface ListContextsOptions {
  agentId?: string;
  sessionKey?: string;
  kind?: string;
  includeInactive?: boolean;
}

// ============================================================================
// Lazy Database Initialization
// ============================================================================

type RouterDbState = {
  db: Database | null;
  dbPath: string | null;
  stmts: PreparedStatements | null;
};

type RouterDbGlobal = typeof globalThis & {
  __raviRouterDbState?: RouterDbState;
};

const routerDbGlobal = globalThis as RouterDbGlobal;
const routerDbState =
  routerDbGlobal.__raviRouterDbState ??
  (routerDbGlobal.__raviRouterDbState = {
    db: null,
    dbPath: null,
    stmts: null,
  });

function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getRaviStateDir(env), "ravi.db");
}

/**
 * Get database connection with lazy initialization.
 * Creates database and schema on first access.
 */
function getDb(): Database {
  const nextDbPath = resolveDbPath();
  if (routerDbState.db !== null && routerDbState.dbPath === nextDbPath) {
    return routerDbState.db;
  }
  if (routerDbState.db !== null && routerDbState.dbPath !== nextDbPath) {
    closeRouterDb();
  }

  const stateDir = getRaviStateDir();

  // Create directory on first access
  mkdirSync(stateDir, { recursive: true });

  // Auto-migrate from legacy path (~/ravi/ravi.db → ~/.ravi/ravi.db)
  if (nextDbPath === DEFAULT_DB_PATH && !existsSync(nextDbPath) && existsSync(LEGACY_DB_PATH)) {
    log.info("Migrating database from ~/ravi/ravi.db to ~/.ravi/ravi.db");
    renameSync(LEGACY_DB_PATH, nextDbPath);
    // Also move WAL/SHM files if they exist
    for (const suffix of ["-wal", "-shm"]) {
      const legacy = LEGACY_DB_PATH + suffix;
      if (existsSync(legacy)) renameSync(legacy, nextDbPath + suffix);
    }
  }

  const db = new Database(nextDbPath);
  routerDbState.db = db;
  routerDbState.dbPath = nextDbPath;

  // WAL mode for concurrent read/write access (CLI + daemon)
  db.exec("PRAGMA journal_mode = WAL");
  // Wait up to 5s for locks to clear instead of failing immediately
  db.exec("PRAGMA busy_timeout = 5000");

  // Enable foreign keys before schema creation
  db.exec("PRAGMA foreign_keys = ON");

  // Initialize schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT,
      cwd TEXT NOT NULL,
      model TEXT,
      provider TEXT,
      remote TEXT,
      remote_user TEXT,
      dm_scope TEXT CHECK(dm_scope IS NULL OR dm_scope IN ('main','per-peer','per-channel-peer','per-account-channel-peer')),
      system_prompt_append TEXT,
      debounce_ms INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS routes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern TEXT NOT NULL,
      account_id TEXT NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      dm_scope TEXT CHECK(dm_scope IS NULL OR dm_scope IN ('main','per-peer','per-channel-peer','per-account-channel-peer')),
      priority INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(pattern, account_id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      session_key TEXT PRIMARY KEY,
      name TEXT,
      sdk_session_id TEXT,
      runtime_provider TEXT,
      runtime_session_json TEXT,
      runtime_session_display_id TEXT,
      agent_id TEXT NOT NULL,
      agent_cwd TEXT NOT NULL,
      chat_type TEXT,
      channel TEXT,
      account_id TEXT,
      group_id TEXT,
      subject TEXT,
      display_name TEXT,
      last_channel TEXT,
      last_to TEXT,
      last_account_id TEXT,
      last_thread_id TEXT,
      model_override TEXT,
      thinking_level TEXT,
      queue_mode TEXT,
      queue_debounce_ms INTEGER,
      queue_cap INTEGER,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      context_tokens INTEGER DEFAULT 0,
      system_sent INTEGER DEFAULT 0,
      aborted_last_run INTEGER DEFAULT 0,
      compaction_count INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      instance_id TEXT NOT NULL DEFAULT '',
      platform_chat_id TEXT NOT NULL,
      normalized_chat_id TEXT NOT NULL,
      chat_type TEXT NOT NULL DEFAULT 'unknown',
      title TEXT,
      avatar_url TEXT,
      metadata_json TEXT,
      raw_provenance_json TEXT,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(channel, instance_id, normalized_chat_id)
    );

    CREATE TABLE IF NOT EXISTS chat_participants (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      platform_identity_id TEXT,
      contact_id TEXT,
      agent_id TEXT,
      raw_platform_user_id TEXT,
      normalized_platform_user_id TEXT,
      role TEXT NOT NULL DEFAULT 'unknown',
      status TEXT NOT NULL DEFAULT 'active',
      source TEXT NOT NULL DEFAULT 'unknown',
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_participants_identity
      ON chat_participants(chat_id, platform_identity_id)
      WHERE platform_identity_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_participants_contact
      ON chat_participants(chat_id, contact_id)
      WHERE contact_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_participants_agent
      ON chat_participants(chat_id, agent_id)
      WHERE agent_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_participants_raw_identity
      ON chat_participants(chat_id, normalized_platform_user_id)
      WHERE platform_identity_id IS NULL AND contact_id IS NULL AND agent_id IS NULL AND normalized_platform_user_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS session_chat_bindings (
      session_key TEXT NOT NULL REFERENCES sessions(session_key) ON DELETE CASCADE,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      agent_id TEXT,
      route_id INTEGER,
      binding_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (session_key, chat_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_session_chat_bindings_session
      ON session_chat_bindings(session_key);
    CREATE INDEX IF NOT EXISTS idx_session_chat_bindings_chat
      ON session_chat_bindings(chat_id);

    CREATE TABLE IF NOT EXISTS session_participants (
      id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL REFERENCES sessions(session_key) ON DELETE CASCADE,
      owner_type TEXT NOT NULL DEFAULT 'unknown' CHECK(owner_type IN ('contact', 'agent', 'unknown')),
      owner_id TEXT,
      platform_identity_id TEXT,
      role TEXT NOT NULL DEFAULT 'unknown',
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_session_participants_owner
      ON session_participants(session_key, owner_type, owner_id)
      WHERE owner_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_session_participants_identity
      ON session_participants(session_key, platform_identity_id)
      WHERE platform_identity_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_session_participants_session
      ON session_participants(session_key);

    CREATE INDEX IF NOT EXISTS idx_routes_priority ON routes(priority DESC);
    CREATE INDEX IF NOT EXISTS idx_routes_agent ON routes(agent_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_sdk ON sessions(sdk_session_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_name ON sessions(name) WHERE name IS NOT NULL;

    -- REBAC: Relationship-based access control
    CREATE TABLE IF NOT EXISTS relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      object_type TEXT NOT NULL,
      object_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_relations_unique
      ON relations(subject_type, subject_id, relation, object_type, object_id);
    CREATE INDEX IF NOT EXISTS idx_relations_subject
      ON relations(subject_type, subject_id);
    CREATE INDEX IF NOT EXISTS idx_relations_object
      ON relations(object_type, object_id);

    -- Message metadata (transcriptions, media paths — for reply reinjection)
    CREATE TABLE IF NOT EXISTS message_metadata (
      message_id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      canonical_chat_id TEXT,
      actor_type TEXT,
      contact_id TEXT,
      agent_id TEXT,
      platform_identity_id TEXT,
      raw_sender_id TEXT,
      normalized_sender_id TEXT,
      identity_confidence REAL,
      identity_provenance_json TEXT,
      transcription TEXT,
      media_path TEXT,
      media_type TEXT,
      created_at INTEGER NOT NULL
    );

    -- Cost tracking: granular per-turn cost events
    CREATE TABLE IF NOT EXISTS cost_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,
      input_cost_usd REAL NOT NULL,
      output_cost_usd REAL NOT NULL,
      cache_cost_usd REAL DEFAULT 0,
      total_cost_usd REAL NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cost_events_agent ON cost_events(agent_id);
    CREATE INDEX IF NOT EXISTS idx_cost_events_session ON cost_events(session_key);
    CREATE INDEX IF NOT EXISTS idx_cost_events_created ON cost_events(created_at);

    -- Session trace: append-only session inspection ledger
    CREATE TABLE IF NOT EXISTS session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL,
      session_name TEXT,
      agent_id TEXT,
      run_id TEXT,
      turn_id TEXT,
      seq INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      event_group TEXT NOT NULL,
      status TEXT,
      timestamp INTEGER NOT NULL,
      source_channel TEXT,
      source_account_id TEXT,
      source_chat_id TEXT,
      source_thread_id TEXT,
      canonical_chat_id TEXT,
      actor_type TEXT,
      contact_id TEXT,
      actor_agent_id TEXT,
      platform_identity_id TEXT,
      raw_sender_id TEXT,
      normalized_sender_id TEXT,
      identity_confidence REAL,
      identity_provenance_json TEXT,
      message_id TEXT,
      provider TEXT,
      model TEXT,
      payload_json TEXT,
      preview TEXT,
      error TEXT,
      duration_ms INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_session_events_key_time
      ON session_events(session_key, timestamp);
    CREATE INDEX IF NOT EXISTS idx_session_events_name_time
      ON session_events(session_name, timestamp);
    CREATE INDEX IF NOT EXISTS idx_session_events_run_seq
      ON session_events(run_id, seq);
    CREATE INDEX IF NOT EXISTS idx_session_events_turn_seq
      ON session_events(turn_id, seq);
    CREATE INDEX IF NOT EXISTS idx_session_events_type_time
      ON session_events(event_type, timestamp);
    CREATE INDEX IF NOT EXISTS idx_session_events_chat_time
      ON session_events(source_chat_id, timestamp);

    -- Omni group metadata cache: local snapshot used by prompt context.
    CREATE TABLE IF NOT EXISTS omni_group_metadata (
      account_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      chat_uuid TEXT,
      external_id TEXT,
      channel TEXT,
      name TEXT,
      description TEXT,
      avatar_url TEXT,
      participant_count INTEGER,
      participants_json TEXT,
      settings_json TEXT,
      platform_metadata_json TEXT,
      fetched_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, instance_id, chat_id)
    );

    CREATE INDEX IF NOT EXISTS idx_omni_group_metadata_fetched
      ON omni_group_metadata(fetched_at);

    CREATE TABLE IF NOT EXISTS session_turns (
      turn_id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL,
      session_name TEXT,
      run_id TEXT,
      agent_id TEXT,
      provider TEXT,
      model TEXT,
      effort TEXT,
      thinking TEXT,
      cwd TEXT,
      status TEXT NOT NULL,
      resume INTEGER NOT NULL DEFAULT 0,
      fork INTEGER NOT NULL DEFAULT 0,
      provider_session_id_before TEXT,
      provider_session_id_after TEXT,
      user_prompt_sha256 TEXT,
      system_prompt_sha256 TEXT,
      request_blob_sha256 TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      error TEXT,
      abort_reason TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_session_turns_session_time
      ON session_turns(session_key, started_at);
    CREATE INDEX IF NOT EXISTS idx_session_turns_run
      ON session_turns(run_id, started_at);

    CREATE TABLE IF NOT EXISTS session_trace_blobs (
      sha256 TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      content_text TEXT,
      content_json TEXT,
      redacted INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_session_trace_blobs_kind
      ON session_trace_blobs(kind, created_at);

    -- Instances: central config entity (one per omni connection)
    CREATE TABLE IF NOT EXISTS instances (
      name         TEXT PRIMARY KEY,
      instance_id  TEXT UNIQUE,
      channel      TEXT NOT NULL DEFAULT 'whatsapp',
      agent        TEXT REFERENCES agents(id) ON DELETE SET NULL,
      dm_policy    TEXT NOT NULL DEFAULT 'open' CHECK(dm_policy IN ('open','pairing','closed')),
      group_policy TEXT NOT NULL DEFAULT 'open' CHECK(group_policy IN ('open','allowlist','closed')),
      dm_scope     TEXT CHECK(dm_scope IS NULL OR dm_scope IN ('main','per-peer','per-channel-peer','per-account-channel-peer')),
      enabled      INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      defaults     TEXT,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contexts (
      context_id TEXT PRIMARY KEY,
      context_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL DEFAULT 'runtime',
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      session_key TEXT REFERENCES sessions(session_key) ON DELETE SET NULL,
      session_name TEXT,
      source_json TEXT,
      capabilities_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      last_used_at INTEGER,
      revoked_at INTEGER
    );

    -- Matrix accounts (all users - both regular users and agents)
    CREATE TABLE IF NOT EXISTS matrix_accounts (
      username TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      homeserver TEXT NOT NULL,
      access_token TEXT NOT NULL,
      device_id TEXT,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER
    );
  `);

  // Migration: add matrix_account column to agents if not exists
  const agentColumns = db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
  if (!agentColumns.some((c) => c.name === "matrix_account")) {
    db.exec("ALTER TABLE agents ADD COLUMN matrix_account TEXT REFERENCES matrix_accounts(username)");
    log.info("Added matrix_account column to agents table");
  }

  // Migration: add heartbeat columns to agents if not exists
  if (!agentColumns.some((c) => c.name === "heartbeat_enabled")) {
    db.exec(`
      ALTER TABLE agents ADD COLUMN heartbeat_enabled INTEGER DEFAULT 0;
    `);
    db.exec(`
      ALTER TABLE agents ADD COLUMN heartbeat_interval_ms INTEGER DEFAULT 1800000;
    `);
    db.exec(`
      ALTER TABLE agents ADD COLUMN heartbeat_model TEXT;
    `);
    db.exec(`
      ALTER TABLE agents ADD COLUMN heartbeat_active_start TEXT;
    `);
    db.exec(`
      ALTER TABLE agents ADD COLUMN heartbeat_active_end TEXT;
    `);
    db.exec(`
      ALTER TABLE agents ADD COLUMN heartbeat_last_run_at INTEGER;
    `);
    log.info("Added heartbeat columns to agents table");
  }

  // Migration: add setting_sources column to agents if not exists
  if (!agentColumns.some((c) => c.name === "setting_sources")) {
    db.exec("ALTER TABLE agents ADD COLUMN setting_sources TEXT");
    log.info("Added setting_sources column to agents table");
  }

  // Migration: add provider column to agents if not exists
  if (!agentColumns.some((c) => c.name === "provider")) {
    db.exec("ALTER TABLE agents ADD COLUMN provider TEXT");
    log.info("Added provider column to agents table");
  }

  if (!agentColumns.some((c) => c.name === "remote")) {
    db.exec("ALTER TABLE agents ADD COLUMN remote TEXT");
    log.info("Added remote column to agents table");
  }

  if (!agentColumns.some((c) => c.name === "remote_user")) {
    db.exec("ALTER TABLE agents ADD COLUMN remote_user TEXT");
    log.info("Added remote_user column to agents table");
  }

  // Migration: drop legacy permission columns (replaced by REBAC)
  const legacyCols = ["allowed_tools", "bash_mode", "bash_allowlist", "bash_denylist"];
  const toDrop = legacyCols.filter((c) => agentColumns.some((ac) => ac.name === c));
  if (toDrop.length > 0) {
    for (const col of toDrop) {
      db.exec(`ALTER TABLE agents DROP COLUMN ${col}`);
    }
    log.info("Dropped legacy permission columns from agents table", { columns: toDrop });
  }

  // Migration: add spec_mode column to agents if not exists
  if (!agentColumns.some((c) => c.name === "spec_mode")) {
    db.exec("ALTER TABLE agents ADD COLUMN spec_mode INTEGER DEFAULT 0");
    log.info("Added spec_mode column to agents table");
  }

  // Migration: add scope isolation columns to agents if not exists
  if (!agentColumns.some((c) => c.name === "contact_scope")) {
    db.exec("ALTER TABLE agents ADD COLUMN contact_scope TEXT");
    db.exec("ALTER TABLE agents ADD COLUMN allowed_sessions TEXT");
    log.info("Added scope isolation columns to agents table");
  }

  // Migration: add agent_mode column to agents if not exists
  if (!agentColumns.some((c) => c.name === "agent_mode")) {
    db.exec("ALTER TABLE agents ADD COLUMN agent_mode TEXT");
    log.info("Added agent_mode column to agents table");
  }

  // Migration: add group_debounce_ms column to agents if not exists
  if (!agentColumns.some((c) => c.name === "group_debounce_ms")) {
    db.exec("ALTER TABLE agents ADD COLUMN group_debounce_ms INTEGER");
    log.info("Added group_debounce_ms column to agents table");
  }

  // Migration: add defaults column to agents if not exists
  if (!agentColumns.some((c) => c.name === "defaults")) {
    db.exec("ALTER TABLE agents ADD COLUMN defaults TEXT");
    log.info("Added defaults column to agents table");
  }

  // Migration: add heartbeat columns to sessions if not exists
  const sessionColumns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
  if (!sessionColumns.some((c) => c.name === "last_heartbeat_text")) {
    db.exec(`
      ALTER TABLE sessions ADD COLUMN last_heartbeat_text TEXT;
    `);
    db.exec(`
      ALTER TABLE sessions ADD COLUMN last_heartbeat_sent_at INTEGER;
    `);
    log.info("Added heartbeat columns to sessions table");
  }

  // Migration: add last_context column to sessions if not exists
  if (!sessionColumns.some((c) => c.name === "last_context")) {
    db.exec("ALTER TABLE sessions ADD COLUMN last_context TEXT");
    log.info("Added last_context column to sessions table");
  }

  // Migration: add runtime_provider column to sessions if not exists
  if (!sessionColumns.some((c) => c.name === "runtime_provider")) {
    db.exec("ALTER TABLE sessions ADD COLUMN runtime_provider TEXT");
    log.info("Added runtime_provider column to sessions table");
  }
  if (!sessionColumns.some((c) => c.name === "runtime_session_json")) {
    db.exec("ALTER TABLE sessions ADD COLUMN runtime_session_json TEXT");
    log.info("Added runtime_session_json column to sessions table");
  }
  if (!sessionColumns.some((c) => c.name === "runtime_session_display_id")) {
    db.exec("ALTER TABLE sessions ADD COLUMN runtime_session_display_id TEXT");
    log.info("Added runtime_session_display_id column to sessions table");
  }
  db.exec(
    "UPDATE sessions SET runtime_provider = 'claude' WHERE runtime_provider IS NULL AND sdk_session_id IS NOT NULL",
  );
  db.exec(`
    UPDATE sessions
    SET runtime_session_display_id = sdk_session_id
    WHERE runtime_session_display_id IS NULL AND sdk_session_id IS NOT NULL
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_runtime_display ON sessions(runtime_session_display_id)");

  // Migration: add policy column to routes if not exists
  const routeColumns = db.prepare("PRAGMA table_info(routes)").all() as Array<{ name: string }>;
  if (!routeColumns.some((c) => c.name === "policy")) {
    db.exec("ALTER TABLE routes ADD COLUMN policy TEXT");
    log.info("Added policy column to routes table");
  }

  // Migration: seed instances table from account.* settings (one-time)
  const instanceCount = (db.prepare("SELECT COUNT(*) as n FROM instances").get() as { n: number }).n;
  if (instanceCount === 0) {
    const settingRows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'account.%'").all() as Array<{
      key: string;
      value: string;
    }>;
    const instanceData: Record<string, Partial<InstanceConfig>> = {};

    for (const { key, value } of settingRows) {
      const m = key.match(/^account\.([^.]+)\.(.+)$/);
      if (!m) continue;
      const [, name, field] = m;
      if (!instanceData[name]) instanceData[name] = { name };
      if (field === "instanceId") instanceData[name].instanceId = value;
      else if (field === "agent") instanceData[name].agent = value;
      else if (field === "dmPolicy" && (value === "open" || value === "pairing" || value === "closed"))
        instanceData[name].dmPolicy = value;
      else if (field === "groupPolicy" && (value === "open" || value === "allowlist" || value === "closed"))
        instanceData[name].groupPolicy = value;
    }

    const insertInstance = db.prepare(`
      INSERT OR IGNORE INTO instances (name, instance_id, channel, agent, dm_policy, group_policy, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const now = Date.now();
    for (const inst of Object.values(instanceData)) {
      if (!inst.name) continue;
      insertInstance.run(
        inst.name,
        inst.instanceId ?? null,
        "whatsapp",
        inst.agent ?? null,
        inst.dmPolicy ?? "open",
        inst.groupPolicy ?? "open",
        inst.enabled === false ? 0 : 1,
        now,
        now,
      );
      log.info("Migrated instance from settings", { name: inst.name });
    }
  }

  // Migration: add ephemeral session columns
  if (!sessionColumns.some((c) => c.name === "ephemeral")) {
    db.exec("ALTER TABLE sessions ADD COLUMN ephemeral INTEGER DEFAULT 0");
    db.exec("ALTER TABLE sessions ADD COLUMN expires_at INTEGER");
    db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_ephemeral ON sessions(ephemeral, expires_at) WHERE ephemeral = 1");
    log.info("Added ephemeral session columns to sessions table");
  }

  // Migration: add name column to sessions (human-readable unique identifier)
  if (!sessionColumns.some((c) => c.name === "name")) {
    db.exec("ALTER TABLE sessions ADD COLUMN name TEXT");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_name ON sessions(name) WHERE name IS NOT NULL");
    log.info("Added name column to sessions table");

    // Migrate existing sessions: generate names from session_key
    const rows = db
      .prepare("SELECT session_key, agent_id, display_name, chat_type, group_id FROM sessions")
      .all() as Array<{
      session_key: string;
      agent_id: string;
      display_name: string | null;
      chat_type: string | null;
      group_id: string | null;
    }>;
    const usedNames = new Set<string>();
    const { slugify } = require("./session-name.js") as typeof import("./session-name.js");
    const updateName = db.prepare("UPDATE sessions SET name = ? WHERE session_key = ?");
    for (const row of rows) {
      let name: string;
      const agent = slugify(row.agent_id);
      if (row.session_key.endsWith(":main")) {
        name = agent;
      } else if (row.display_name) {
        name = `${agent}-${slugify(row.display_name)}`;
      } else if (row.group_id) {
        const cleanId = row.group_id.replace(/^group:/, "").slice(-8);
        name = `${agent}-group-${cleanId}`;
      } else {
        // DM or unknown — use last part of session key
        const parts = row.session_key.split(":");
        const lastPart = parts[parts.length - 1];
        const clean = slugify(lastPart).slice(-12);
        name = `${agent}-${clean || "session"}`;
      }
      // Deduplicate
      let finalName = name.slice(0, 64);
      let i = 2;
      while (usedNames.has(finalName)) {
        finalName = `${name.slice(0, 60)}-${i}`;
        i++;
      }
      usedNames.add(finalName);
      updateName.run(finalName, row.session_key);
    }
    if (rows.length > 0) {
      log.info(`Migrated ${rows.length} session names`);
    }
  }

  // Migration: create cron_jobs table
  db.exec(`
    CREATE TABLE IF NOT EXISTS cron_jobs (
      id TEXT PRIMARY KEY,
      agent_id TEXT,
      name TEXT NOT NULL,
      description TEXT,
      enabled INTEGER DEFAULT 1,
      delete_after_run INTEGER DEFAULT 0,

      -- Schedule (one of these is set based on schedule_type)
      schedule_type TEXT NOT NULL,
      schedule_at INTEGER,
      schedule_every INTEGER,
      schedule_cron TEXT,
      schedule_timezone TEXT,

      -- Execution config
      session_target TEXT DEFAULT 'main',
      reply_session TEXT,
      payload_text TEXT NOT NULL,

      -- State
      next_run_at INTEGER,
      last_run_at INTEGER,
      last_status TEXT,
      last_error TEXT,
      last_duration_ms INTEGER,

      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cron_jobs_enabled ON cron_jobs(enabled);
    CREATE INDEX IF NOT EXISTS idx_cron_jobs_next_run ON cron_jobs(next_run_at);
  `);

  // Migration: add reply_session to cron_jobs
  try {
    db.exec("ALTER TABLE cron_jobs ADD COLUMN reply_session TEXT");
  } catch {
    /* column already exists */
  }

  db.exec(`
    -- Event triggers
    CREATE TABLE IF NOT EXISTS triggers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      agent_id TEXT,
      topic TEXT NOT NULL,
      message TEXT NOT NULL,
      session TEXT DEFAULT 'isolated' CHECK(session IN ('main','isolated')),
      enabled INTEGER DEFAULT 1,
      cooldown_ms INTEGER DEFAULT 5000,
      last_fired_at INTEGER,
      fire_count INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_triggers_enabled ON triggers(enabled);
    CREATE INDEX IF NOT EXISTS idx_triggers_topic ON triggers(topic);
  `);

  // Migrations for triggers
  const triggerColumns = db.prepare("PRAGMA table_info(triggers)").all() as Array<{ name: string }>;
  if (!triggerColumns.some((c) => c.name === "reply_session")) {
    db.exec("ALTER TABLE triggers ADD COLUMN reply_session TEXT");
    log.info("Added reply_session column to triggers table");
  }
  if (!triggerColumns.some((c) => c.name === "account_id")) {
    db.exec("ALTER TABLE triggers ADD COLUMN account_id TEXT");
    log.info("Added account_id column to triggers table");
  }
  if (!triggerColumns.some((c) => c.name === "filter")) {
    db.exec("ALTER TABLE triggers ADD COLUMN filter TEXT");
    log.info("Added filter column to triggers table");
  }

  // Migration: add account_id column to cron_jobs
  const cronColumns = db.prepare("PRAGMA table_info(cron_jobs)").all() as Array<{ name: string }>;
  if (!cronColumns.some((c) => c.name === "account_id")) {
    db.exec("ALTER TABLE cron_jobs ADD COLUMN account_id TEXT");
    log.info("Added account_id column to cron_jobs table");
  }

  // Migration: add heartbeat_account_id column to agents
  if (!agentColumns.some((c) => c.name === "heartbeat_account_id")) {
    db.exec("ALTER TABLE agents ADD COLUMN heartbeat_account_id TEXT");
    log.info("Added heartbeat_account_id column to agents table");
  }

  // Migration: add account_id column to routes (recreate table for UNIQUE constraint change)
  const routeColumnsV1 = db.prepare("PRAGMA table_info(routes)").all() as Array<{ name: string }>;
  if (!routeColumnsV1.some((c) => c.name === "account_id")) {
    db.exec("PRAGMA foreign_keys=OFF");
    try {
      db.exec(`
        BEGIN;
        CREATE TABLE routes_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          pattern TEXT NOT NULL,
          account_id TEXT NOT NULL,
          agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          dm_scope TEXT CHECK(dm_scope IS NULL OR dm_scope IN ('main','per-peer','per-channel-peer','per-account-channel-peer')),
          priority INTEGER DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(pattern, account_id)
        );
        INSERT INTO routes_new (id, pattern, account_id, agent_id, dm_scope, priority, created_at, updated_at)
          SELECT id, pattern, 'unknown', agent_id, dm_scope, priority, created_at, updated_at FROM routes;
        DROP TABLE routes;
        ALTER TABLE routes_new RENAME TO routes;
        CREATE INDEX IF NOT EXISTS idx_routes_priority ON routes(priority DESC);
        CREATE INDEX IF NOT EXISTS idx_routes_agent ON routes(agent_id);
        CREATE INDEX IF NOT EXISTS idx_routes_account ON routes(account_id);
        COMMIT;
      `);
      log.info("Migrated routes table: added account_id column with UNIQUE(pattern, account_id)");
    } finally {
      db.exec("PRAGMA foreign_keys=ON");
    }
  }
  // Ensure account index exists (for fresh DBs that skip migration)
  db.exec("CREATE INDEX IF NOT EXISTS idx_routes_account ON routes(account_id)");

  // Migration: add session_name column to routes
  const routeColumnsAfter = db.prepare("PRAGMA table_info(routes)").all() as Array<{ name: string }>;
  if (!routeColumnsAfter.some((c) => c.name === "session_name")) {
    db.exec("ALTER TABLE routes ADD COLUMN session_name TEXT");
    log.info("Added session_name column to routes table");
  }

  // Migration: add channel column to routes (null = applies to all channels)
  if (!routeColumnsAfter.some((c) => c.name === "channel")) {
    db.exec("ALTER TABLE routes ADD COLUMN channel TEXT");
    // Drop old unique index and recreate including channel
    db.exec("DROP INDEX IF EXISTS idx_routes_unique_pattern");
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_routes_unique ON routes(pattern, account_id, COALESCE(channel, ''))",
    );
    log.info("Added channel column to routes table");
  }

  // Migration: soft-delete columns for routes and instances + audit_log table
  if (!routeColumnsAfter.some((c) => c.name === "deleted_at")) {
    db.exec("ALTER TABLE routes ADD COLUMN deleted_at INTEGER");
    log.info("Added deleted_at column to routes table");
  }
  const instanceColumnsNow = db.prepare("PRAGMA table_info(instances)").all() as Array<{ name: string }>;
  if (!instanceColumnsNow.some((c) => c.name === "deleted_at")) {
    db.exec("ALTER TABLE instances ADD COLUMN deleted_at INTEGER");
    log.info("Added deleted_at column to instances table");
  }
  if (!instanceColumnsNow.some((c) => c.name === "enabled")) {
    db.exec("ALTER TABLE instances ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1");
    log.info("Added enabled column to instances table");
  }
  if (!instanceColumnsNow.some((c) => c.name === "defaults")) {
    db.exec("ALTER TABLE instances ADD COLUMN defaults TEXT");
    log.info("Added defaults column to instances table");
  }

  const contextColumns = db.prepare("PRAGMA table_info(contexts)").all() as Array<{ name: string }>;
  if (contextColumns.length > 0 && !contextColumns.some((c) => c.name === "context_id")) {
    db.exec("PRAGMA foreign_keys=OFF");
    try {
      db.exec(`
        BEGIN;
        CREATE TABLE contexts_new (
          context_id TEXT PRIMARY KEY,
          context_key TEXT NOT NULL UNIQUE,
          kind TEXT NOT NULL DEFAULT 'runtime',
          agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
          session_key TEXT REFERENCES sessions(session_key) ON DELETE SET NULL,
          session_name TEXT,
          source_json TEXT,
          capabilities_json TEXT NOT NULL DEFAULT '[]',
          metadata_json TEXT,
          created_at INTEGER NOT NULL,
          expires_at INTEGER,
          last_used_at INTEGER,
          revoked_at INTEGER
        );
        INSERT INTO contexts_new (
          context_id, context_key, kind, agent_id, session_key, session_name,
          source_json, capabilities_json, metadata_json, created_at, expires_at, last_used_at, revoked_at
        )
        SELECT
          'ctx_legacy_' || lower(hex(randomblob(12))),
          context_key,
          'legacy',
          agent_id,
          session_key,
          session_name,
          CASE
            WHEN source_channel IS NOT NULL AND source_account_id IS NOT NULL AND source_chat_id IS NOT NULL
              THEN json_object('channel', source_channel, 'accountId', source_account_id, 'chatId', source_chat_id)
            ELSE NULL
          END,
          '[]',
          NULL,
          created_at,
          NULL,
          updated_at,
          NULL
        FROM contexts;
        DROP TABLE contexts;
        ALTER TABLE contexts_new RENAME TO contexts;
        COMMIT;
      `);
      log.info("Migrated contexts table to central registry schema");
    } finally {
      db.exec("PRAGMA foreign_keys=ON");
    }
  }
  const contextColumnsNow = db.prepare("PRAGMA table_info(contexts)").all() as Array<{ name: string }>;
  if (!contextColumnsNow.some((c) => c.name === "kind")) {
    db.exec("ALTER TABLE contexts ADD COLUMN kind TEXT NOT NULL DEFAULT 'runtime'");
  }
  if (!contextColumnsNow.some((c) => c.name === "capabilities_json")) {
    db.exec("ALTER TABLE contexts ADD COLUMN capabilities_json TEXT NOT NULL DEFAULT '[]'");
  }
  if (!contextColumnsNow.some((c) => c.name === "metadata_json")) {
    db.exec("ALTER TABLE contexts ADD COLUMN metadata_json TEXT");
  }
  if (!contextColumnsNow.some((c) => c.name === "expires_at")) {
    db.exec("ALTER TABLE contexts ADD COLUMN expires_at INTEGER");
  }
  if (!contextColumnsNow.some((c) => c.name === "last_used_at")) {
    db.exec("ALTER TABLE contexts ADD COLUMN last_used_at INTEGER");
  }
  if (!contextColumnsNow.some((c) => c.name === "revoked_at")) {
    db.exec("ALTER TABLE contexts ADD COLUMN revoked_at INTEGER");
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_contexts_key ON contexts(context_key)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_contexts_agent ON contexts(agent_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_contexts_session ON contexts(session_key)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_contexts_expires ON contexts(expires_at)");
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      action     TEXT NOT NULL,
      entity     TEXT NOT NULL,
      entity_id  TEXT NOT NULL,
      old_value  TEXT,
      actor      TEXT NOT NULL DEFAULT 'daemon',
      ts         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id, ts DESC);

    CREATE TABLE IF NOT EXISTS router_meta (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  ensureIdentityChatMigrations(db);
  backfillChatModelOnce(db);

  // Create default agent if none exist
  const count = db.prepare("SELECT COUNT(*) as count FROM agents").get() as { count: number };
  if (count.count === 0) {
    const now = Date.now();
    db.prepare(`
      INSERT INTO agents (id, name, cwd, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run("main", "Ravi", join(RAVI_DIR, "main"), now, now);
    log.info("Created default agent: main");
  }

  // Startup cleanup: remove any expired ephemeral sessions left over from previous runs
  const expiredCount = (
    db
      .prepare("SELECT COUNT(*) as n FROM sessions WHERE ephemeral = 1 AND expires_at IS NOT NULL AND expires_at <= ?")
      .get(Date.now()) as { n: number }
  ).n;
  if (expiredCount > 0) {
    db.prepare("DELETE FROM sessions WHERE ephemeral = 1 AND expires_at IS NOT NULL AND expires_at <= ?").run(
      Date.now(),
    );
    log.info("Cleaned up expired ephemeral sessions at startup", { count: expiredCount });
  }

  log.debug("Database initialized", { path: nextDbPath });
  return db;
}

/**
 * Get the number of rows changed by the last INSERT/UPDATE/DELETE.
 * Uses SQLite's changes() function since bun:sqlite doesn't expose db.changes.
 */
function getDbChanges(): number {
  const row = getDb().prepare("SELECT changes() AS c").get() as { c: number } | null;
  return row?.c ?? 0;
}

// ============================================================================
// Identity/chats schema helpers
// ============================================================================

function semanticId(prefix: string, parts: Array<string | null | undefined>): string {
  const hash = createHash("sha256")
    .update(parts.map((part) => part ?? "").join("\x1f"))
    .digest("hex")
    .slice(0, 24);
  return `${prefix}_${hash}`;
}

function tableHasColumn(database: Database, table: string, column: string): boolean {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((c) => c.name === column);
}

function ensureColumn(database: Database, table: string, column: string, definition: string): void {
  if (!tableHasColumn(database, table, column)) {
    try {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      log.info("Added identity/chat schema column", { table, column });
    } catch (error) {
      if (isDuplicateColumnRace(error) && tableHasColumn(database, table, column)) {
        log.debug("Identity/chat schema column already added by another process", { table, column });
        return;
      }
      throw error;
    }
  }
}

function isDuplicateColumnRace(error: unknown): boolean {
  return error instanceof Error && /duplicate column name/i.test(error.message);
}

function ensureIdentityChatMigrations(database: Database): void {
  ensureColumn(database, "message_metadata", "canonical_chat_id", "TEXT");
  ensureColumn(database, "message_metadata", "actor_type", "TEXT");
  ensureColumn(database, "message_metadata", "contact_id", "TEXT");
  ensureColumn(database, "message_metadata", "agent_id", "TEXT");
  ensureColumn(database, "message_metadata", "platform_identity_id", "TEXT");
  ensureColumn(database, "message_metadata", "raw_sender_id", "TEXT");
  ensureColumn(database, "message_metadata", "normalized_sender_id", "TEXT");
  ensureColumn(database, "message_metadata", "identity_confidence", "REAL");
  ensureColumn(database, "message_metadata", "identity_provenance_json", "TEXT");

  ensureColumn(database, "session_events", "canonical_chat_id", "TEXT");
  ensureColumn(database, "session_events", "actor_type", "TEXT");
  ensureColumn(database, "session_events", "contact_id", "TEXT");
  ensureColumn(database, "session_events", "actor_agent_id", "TEXT");
  ensureColumn(database, "session_events", "platform_identity_id", "TEXT");
  ensureColumn(database, "session_events", "raw_sender_id", "TEXT");
  ensureColumn(database, "session_events", "normalized_sender_id", "TEXT");
  ensureColumn(database, "session_events", "identity_confidence", "REAL");
  ensureColumn(database, "session_events", "identity_provenance_json", "TEXT");

  database.exec(
    "CREATE INDEX IF NOT EXISTS idx_message_metadata_canonical_chat ON message_metadata(canonical_chat_id)",
  );
  database.exec("CREATE INDEX IF NOT EXISTS idx_session_events_canonical_chat ON session_events(canonical_chat_id)");
}

function cleanJsonRecord(value: Record<string, unknown> | null | undefined): string | null {
  if (!value || Object.keys(value).length === 0) return null;
  return JSON.stringify(value);
}

function parseJsonRecord(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function mergeJsonRecords(
  ...values: Array<Record<string, unknown> | null | undefined>
): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = {};
  for (const value of values) {
    if (!value) continue;
    Object.assign(merged, value);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function normalizeChannelId(channel: string | null | undefined): string {
  const cleaned = channel
    ?.trim()
    .toLowerCase()
    .replace(/-baileys$/, "");
  return cleaned || "unknown";
}

function normalizeChatIdentity(channel: string, platformChatId: string, chatType?: ChatType): string {
  const trimmed = platformChatId.trim();
  if (!trimmed) return "unknown";
  const threadSeparator = trimmed.indexOf("#");
  if (threadSeparator !== -1) {
    const baseChatId = trimmed.slice(0, threadSeparator);
    const threadId = trimmed
      .slice(threadSeparator + 1)
      .trim()
      .toLowerCase();
    const baseType =
      chatType === "thread" || chatType === "unknown" || !chatType ? inferChatType(baseChatId, undefined) : chatType;
    const normalizedBase = normalizeChatIdentity(channel, baseChatId, baseType);
    return threadId ? `${normalizedBase}#${threadId}` : normalizedBase;
  }
  if (channel === "whatsapp") {
    const normalized = normalizePhone(trimmed);
    if (chatType === "group" || normalized.startsWith("group:") || trimmed.endsWith("@g.us")) {
      return normalized.startsWith("group:") ? normalized : `group:${normalized}`;
    }
    return normalized || trimmed.toLowerCase();
  }
  return trimmed.toLowerCase();
}

function inferChatType(platformChatId: string, explicit?: ChatType | null): ChatType {
  if (explicit && explicit !== "unknown") return explicit;
  if (platformChatId.includes("#")) return "thread";
  if (platformChatId.endsWith("@g.us") || platformChatId.startsWith("group:")) return "group";
  return "dm";
}

function rowToChat(row: ChatRow): ChatRecord {
  return {
    id: row.id,
    channel: row.channel,
    instanceId: row.instance_id,
    platformChatId: row.platform_chat_id,
    normalizedChatId: row.normalized_chat_id,
    chatType: row.chat_type as ChatType,
    title: row.title ?? undefined,
    avatarUrl: row.avatar_url ?? undefined,
    metadata: parseJsonRecord(row.metadata_json),
    rawProvenance: parseJsonRecord(row.raw_provenance_json),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToChatParticipant(row: ChatParticipantRow): ChatParticipantRecord {
  return {
    id: row.id,
    chatId: row.chat_id,
    participantType: inferChatParticipantType({
      contactId: row.contact_id,
      agentId: row.agent_id,
    }),
    platformIdentityId: row.platform_identity_id ?? undefined,
    contactId: row.contact_id ?? undefined,
    agentId: row.agent_id ?? undefined,
    rawPlatformUserId: row.raw_platform_user_id ?? undefined,
    normalizedPlatformUserId: row.normalized_platform_user_id ?? undefined,
    role: row.role,
    status: row.status,
    source: row.source,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToSessionChatBinding(row: SessionChatBindingRow): SessionChatBindingRecord {
  return {
    sessionKey: row.session_key,
    chatId: row.chat_id,
    agentId: row.agent_id ?? undefined,
    routeId: row.route_id ?? undefined,
    bindingReason: row.binding_reason ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToSessionParticipant(row: SessionParticipantRow): SessionParticipantRecord {
  return {
    id: row.id,
    sessionKey: row.session_key,
    ownerType: row.owner_type as SessionParticipantOwnerType,
    ownerId: row.owner_id ?? undefined,
    platformIdentityId: row.platform_identity_id ?? undefined,
    role: row.role,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    messageCount: row.message_count,
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function upsertChat(database: Database, input: UpsertChatInput): ChatRecord {
  const now = input.seenAt ?? Date.now();
  const channel = normalizeChannelId(input.channel);
  const instanceId = input.instanceId?.trim() ?? "";
  const chatType = inferChatType(input.platformChatId, input.chatType);
  const normalizedChatId =
    input.normalizedChatId?.trim() || normalizeChatIdentity(channel, input.platformChatId, chatType);
  const id = semanticId("chat", [channel, instanceId, normalizedChatId]);

  database
    .prepare(
      `
      INSERT INTO chats (
        id, channel, instance_id, platform_chat_id, normalized_chat_id, chat_type,
        title, avatar_url, metadata_json, raw_provenance_json,
        first_seen_at, last_seen_at, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(channel, instance_id, normalized_chat_id) DO UPDATE SET
        platform_chat_id = excluded.platform_chat_id,
        chat_type = excluded.chat_type,
        title = COALESCE(excluded.title, chats.title),
        avatar_url = COALESCE(excluded.avatar_url, chats.avatar_url),
        metadata_json = COALESCE(excluded.metadata_json, chats.metadata_json),
        raw_provenance_json = COALESCE(excluded.raw_provenance_json, chats.raw_provenance_json),
        last_seen_at = MAX(chats.last_seen_at, excluded.last_seen_at),
        updated_at = excluded.updated_at
    `,
    )
    .run(
      id,
      channel,
      instanceId,
      input.platformChatId,
      normalizedChatId,
      chatType,
      input.title ?? null,
      input.avatarUrl ?? null,
      cleanJsonRecord(input.metadata),
      cleanJsonRecord(input.rawProvenance),
      now,
      now,
      now,
      now,
    );

  const row = database
    .prepare("SELECT * FROM chats WHERE channel = ? AND instance_id = ? AND normalized_chat_id = ?")
    .get(channel, instanceId, normalizedChatId) as ChatRow;
  return rowToChat(row);
}

function normalizedParticipantId(input: UpsertChatParticipantInput): string | null {
  const explicit = input.normalizedPlatformUserId?.trim();
  if (explicit) return explicit;
  const raw = input.rawPlatformUserId?.trim();
  if (!raw) return null;
  return normalizePhone(raw) || raw.toLowerCase();
}

function inferChatParticipantType(input: { contactId?: string | null; agentId?: string | null }): ChatParticipantType {
  if (input.agentId) return "agent";
  if (input.contactId) return "contact";
  return "raw";
}

function validateChatParticipantInput(input: UpsertChatParticipantInput): void {
  if (input.contactId && input.agentId) {
    throw new Error("Chat participant cannot be both contact and agent");
  }
}

function chatParticipantSemanticParts(
  input: UpsertChatParticipantInput,
  normalized: string | null,
): Array<string | null | undefined> {
  if (input.agentId) return [input.chatId, "agent", input.agentId];
  if (input.contactId) return [input.chatId, "contact", input.contactId];
  if (input.platformIdentityId) return [input.chatId, "platform", input.platformIdentityId];
  return [input.chatId, "raw", normalized];
}

interface ExistingChatParticipantMatches {
  semantic?: string;
  contact?: string;
  agent?: string;
  platform?: string;
  raw?: string;
  all: string[];
}

function pushChatParticipantMatch(
  matches: ExistingChatParticipantMatches,
  kind: keyof Omit<ExistingChatParticipantMatches, "all">,
  id: string | undefined,
): void {
  if (!id) return;
  matches[kind] ??= id;
  if (!matches.all.includes(id)) {
    matches.all.push(id);
  }
}

function findExistingChatParticipantMatches(
  database: Database,
  input: UpsertChatParticipantInput,
  normalized: string | null,
  semanticParticipantId: string,
): ExistingChatParticipantMatches {
  const matches: ExistingChatParticipantMatches = { all: [] };
  const byId = database.prepare("SELECT id FROM chat_participants WHERE id = ?").get(semanticParticipantId) as
    | { id: string }
    | undefined;
  pushChatParticipantMatch(matches, "semantic", byId?.id);

  if (input.contactId) {
    const row = database
      .prepare("SELECT id FROM chat_participants WHERE chat_id = ? AND contact_id = ?")
      .get(input.chatId, input.contactId) as { id: string } | undefined;
    pushChatParticipantMatch(matches, "contact", row?.id);
  }

  if (input.agentId) {
    const row = database
      .prepare("SELECT id FROM chat_participants WHERE chat_id = ? AND agent_id = ?")
      .get(input.chatId, input.agentId) as { id: string } | undefined;
    pushChatParticipantMatch(matches, "agent", row?.id);
  }

  if (input.platformIdentityId) {
    const row = database
      .prepare("SELECT id FROM chat_participants WHERE chat_id = ? AND platform_identity_id = ?")
      .get(input.chatId, input.platformIdentityId) as { id: string } | undefined;
    pushChatParticipantMatch(matches, "platform", row?.id);
  }

  if (normalized) {
    const row = database
      .prepare(
        `
        SELECT id
        FROM chat_participants
        WHERE chat_id = ?
          AND normalized_platform_user_id = ?
          AND platform_identity_id IS NULL
          AND contact_id IS NULL
          AND agent_id IS NULL
      `,
      )
      .get(input.chatId, normalized) as { id: string } | undefined;
    pushChatParticipantMatch(matches, "raw", row?.id);
  }

  return matches;
}

function listChatParticipantsByIds(database: Database, ids: string[]): ChatParticipantRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return database
    .prepare(`SELECT * FROM chat_participants WHERE id IN (${placeholders})`)
    .all(...ids) as ChatParticipantRow[];
}

function upsertChatParticipant(database: Database, input: UpsertChatParticipantInput): ChatParticipantRecord {
  validateChatParticipantInput(input);
  const now = input.seenAt ?? Date.now();
  const normalized = normalizedParticipantId(input);
  const semanticParticipantId = semanticId("cp", chatParticipantSemanticParts(input, normalized));
  const matches = findExistingChatParticipantMatches(database, input, normalized, semanticParticipantId);
  const id =
    matches.semantic ?? matches.agent ?? matches.contact ?? matches.platform ?? matches.raw ?? semanticParticipantId;
  const mergedRows = listChatParticipantsByIds(database, matches.all);
  const duplicateIds = matches.all.filter((existingId) => existingId !== id);
  const firstSeenAt = Math.min(now, ...mergedRows.map((row) => row.first_seen_at));
  const lastSeenAt = Math.max(now, ...mergedRows.map((row) => row.last_seen_at));
  const mergedMetadata = mergeJsonRecords(
    ...mergedRows.map((row) => parseJsonRecord(row.metadata_json)),
    input.metadata ?? undefined,
  );

  if (duplicateIds.length > 0) {
    const placeholders = duplicateIds.map(() => "?").join(", ");
    database.prepare(`DELETE FROM chat_participants WHERE id IN (${placeholders})`).run(...duplicateIds);
  }

  database
    .prepare(
      `
      INSERT INTO chat_participants (
        id, chat_id, platform_identity_id, contact_id, agent_id,
        raw_platform_user_id, normalized_platform_user_id, role, status, source,
        first_seen_at, last_seen_at, metadata_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        platform_identity_id = COALESCE(excluded.platform_identity_id, chat_participants.platform_identity_id),
        contact_id = COALESCE(excluded.contact_id, chat_participants.contact_id),
        agent_id = COALESCE(excluded.agent_id, chat_participants.agent_id),
        raw_platform_user_id = COALESCE(excluded.raw_platform_user_id, chat_participants.raw_platform_user_id),
        normalized_platform_user_id = COALESCE(excluded.normalized_platform_user_id, chat_participants.normalized_platform_user_id),
        role = CASE WHEN excluded.role != 'unknown' THEN excluded.role ELSE chat_participants.role END,
        status = excluded.status,
        source = excluded.source,
        first_seen_at = MIN(chat_participants.first_seen_at, excluded.first_seen_at),
        last_seen_at = MAX(chat_participants.last_seen_at, excluded.last_seen_at),
        metadata_json = COALESCE(excluded.metadata_json, chat_participants.metadata_json),
        updated_at = excluded.updated_at
    `,
    )
    .run(
      id,
      input.chatId,
      input.platformIdentityId ?? null,
      input.contactId ?? null,
      input.agentId ?? null,
      input.rawPlatformUserId ?? null,
      normalized,
      input.role ?? "unknown",
      input.status ?? "active",
      input.source ?? "unknown",
      firstSeenAt,
      lastSeenAt,
      cleanJsonRecord(mergedMetadata),
      now,
      now,
    );

  const row = database.prepare("SELECT * FROM chat_participants WHERE id = ?").get(id) as ChatParticipantRow;
  return rowToChatParticipant(row);
}

function bindSessionToChat(
  database: Database,
  input: {
    sessionKey: string;
    chatId: string;
    agentId?: string | null;
    routeId?: number | null;
    bindingReason?: string | null;
    seenAt?: number;
  },
): SessionChatBindingRecord {
  const now = input.seenAt ?? Date.now();
  database
    .prepare(
      `
      INSERT INTO session_chat_bindings (
        session_key, chat_id, agent_id, route_id, binding_reason, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_key) DO UPDATE SET
        chat_id = excluded.chat_id,
        agent_id = COALESCE(excluded.agent_id, session_chat_bindings.agent_id),
        route_id = COALESCE(excluded.route_id, session_chat_bindings.route_id),
        binding_reason = COALESCE(excluded.binding_reason, session_chat_bindings.binding_reason),
        updated_at = excluded.updated_at
    `,
    )
    .run(
      input.sessionKey,
      input.chatId,
      input.agentId ?? null,
      input.routeId ?? null,
      input.bindingReason ?? null,
      now,
      now,
    );

  const row = database.prepare("SELECT * FROM session_chat_bindings WHERE session_key = ?").get(input.sessionKey) as
    | SessionChatBindingRow
    | undefined;
  if (!row) throw new Error(`Session chat binding not found after upsert: ${input.sessionKey}`);
  return rowToSessionChatBinding(row);
}

interface ExistingSessionParticipantMatches {
  semantic?: string;
  owner?: string;
  platform?: string;
  all: string[];
}

function pushSessionParticipantMatch(
  matches: ExistingSessionParticipantMatches,
  kind: keyof Omit<ExistingSessionParticipantMatches, "all">,
  id: string | undefined,
): void {
  if (!id) return;
  matches[kind] ??= id;
  if (!matches.all.includes(id)) {
    matches.all.push(id);
  }
}

function findExistingSessionParticipantMatches(
  database: Database,
  input: UpsertSessionParticipantInput,
  ownerType: SessionParticipantOwnerType,
  semanticParticipantId: string,
): ExistingSessionParticipantMatches {
  const matches: ExistingSessionParticipantMatches = { all: [] };
  const byId = database.prepare("SELECT id FROM session_participants WHERE id = ?").get(semanticParticipantId) as
    | { id: string }
    | undefined;
  pushSessionParticipantMatch(matches, "semantic", byId?.id);

  if (input.ownerId) {
    const row = database
      .prepare("SELECT id FROM session_participants WHERE session_key = ? AND owner_type = ? AND owner_id = ?")
      .get(input.sessionKey, ownerType, input.ownerId) as { id: string } | undefined;
    pushSessionParticipantMatch(matches, "owner", row?.id);
  }

  if (input.platformIdentityId) {
    const row = database
      .prepare("SELECT id FROM session_participants WHERE session_key = ? AND platform_identity_id = ?")
      .get(input.sessionKey, input.platformIdentityId) as { id: string } | undefined;
    pushSessionParticipantMatch(matches, "platform", row?.id);
  }

  return matches;
}

function listSessionParticipantsByIds(database: Database, ids: string[]): SessionParticipantRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return database
    .prepare(`SELECT * FROM session_participants WHERE id IN (${placeholders})`)
    .all(...ids) as SessionParticipantRow[];
}

function upsertSessionParticipant(database: Database, input: UpsertSessionParticipantInput): SessionParticipantRecord {
  const now = input.seenAt ?? Date.now();
  const ownerType = input.ownerType ?? (input.ownerId ? "contact" : "unknown");
  const semanticParticipantId = semanticId("sp", [
    input.sessionKey,
    ownerType,
    input.ownerId,
    input.platformIdentityId,
  ]);
  const matches = findExistingSessionParticipantMatches(database, input, ownerType, semanticParticipantId);
  const id = matches.semantic ?? matches.owner ?? matches.platform ?? semanticParticipantId;
  const mergedRows = listSessionParticipantsByIds(database, matches.all);
  const duplicateIds = matches.all.filter((existingId) => existingId !== id);
  const increment = input.incrementMessageCount === false ? 0 : 1;
  const firstSeenAt = Math.min(now, ...mergedRows.map((row) => row.first_seen_at));
  const lastSeenAt = Math.max(now, ...mergedRows.map((row) => row.last_seen_at));
  const messageCount = mergedRows.reduce((total, row) => total + row.message_count, 0) + increment;
  const mergedMetadata = mergeJsonRecords(
    ...mergedRows.map((row) => parseJsonRecord(row.metadata_json)),
    input.metadata ?? undefined,
  );

  if (duplicateIds.length > 0) {
    const placeholders = duplicateIds.map(() => "?").join(", ");
    database.prepare(`DELETE FROM session_participants WHERE id IN (${placeholders})`).run(...duplicateIds);
  }

  database
    .prepare(
      `
      INSERT INTO session_participants (
        id, session_key, owner_type, owner_id, platform_identity_id, role,
        first_seen_at, last_seen_at, message_count, metadata_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        owner_type = CASE WHEN excluded.owner_type != 'unknown' THEN excluded.owner_type ELSE session_participants.owner_type END,
        owner_id = COALESCE(excluded.owner_id, session_participants.owner_id),
        platform_identity_id = COALESCE(excluded.platform_identity_id, session_participants.platform_identity_id),
        role = CASE WHEN excluded.role != 'unknown' THEN excluded.role ELSE session_participants.role END,
        first_seen_at = MIN(session_participants.first_seen_at, excluded.first_seen_at),
        last_seen_at = MAX(session_participants.last_seen_at, excluded.last_seen_at),
        message_count = excluded.message_count,
        metadata_json = COALESCE(excluded.metadata_json, session_participants.metadata_json),
        updated_at = excluded.updated_at
    `,
    )
    .run(
      id,
      input.sessionKey,
      ownerType,
      input.ownerId ?? null,
      input.platformIdentityId ?? null,
      input.role ?? "unknown",
      firstSeenAt,
      lastSeenAt,
      messageCount,
      cleanJsonRecord(mergedMetadata),
      now,
      now,
    );

  const row = database.prepare("SELECT * FROM session_participants WHERE id = ?").get(id) as SessionParticipantRow;
  return rowToSessionParticipant(row);
}

function backfillChatModel(database: Database): void {
  const now = Date.now();
  const txn = database.transaction(() => {
    const groupRows = database.prepare("SELECT * FROM omni_group_metadata").all() as Array<{
      account_id: string;
      instance_id: string;
      chat_id: string;
      chat_uuid: string | null;
      external_id: string | null;
      channel: string | null;
      name: string | null;
      avatar_url: string | null;
      participant_count: number | null;
      participants_json: string | null;
      platform_metadata_json: string | null;
      fetched_at: number;
    }>;

    for (const row of groupRows) {
      const chat = upsertChat(database, {
        channel: row.channel ?? "whatsapp",
        instanceId: row.instance_id,
        platformChatId: row.chat_id,
        chatType: "group",
        title: row.name,
        avatarUrl: row.avatar_url,
        metadata: {
          accountId: row.account_id,
          chatUuid: row.chat_uuid,
          externalId: row.external_id,
          participantCount: row.participant_count,
        },
        rawProvenance: {
          sourceTable: "omni_group_metadata",
          accountId: row.account_id,
          instanceId: row.instance_id,
          chatId: row.chat_id,
          chatUuid: row.chat_uuid,
          externalId: row.external_id,
          platformMetadata: parseJsonRecord(row.platform_metadata_json),
        },
        seenAt: row.fetched_at || now,
      });

      const participants = parseParticipantsJson(row.participants_json);
      for (const participant of participants) {
        upsertChatParticipant(database, {
          chatId: chat.id,
          rawPlatformUserId: participant.platformUserId,
          normalizedPlatformUserId: normalizePhone(participant.platformUserId) || participant.platformUserId,
          role: normalizeParticipantRole(participant.role),
          status: "active",
          source: "omni",
          metadata: {
            omniParticipantId: participant.id ?? null,
            displayName: participant.displayName ?? null,
          },
          seenAt: row.fetched_at || now,
        });
      }
    }

    const sessionRows = database
      .prepare(
        `
        SELECT session_key, agent_id, channel, account_id, group_id, last_channel, last_account_id,
               last_to, last_thread_id, chat_type, display_name, subject, updated_at, created_at
        FROM sessions
        WHERE COALESCE(last_to, group_id) IS NOT NULL
      `,
      )
      .all() as Array<{
      session_key: string;
      agent_id: string;
      channel: string | null;
      account_id: string | null;
      group_id: string | null;
      last_channel: string | null;
      last_account_id: string | null;
      last_to: string | null;
      last_thread_id: string | null;
      chat_type: string | null;
      display_name: string | null;
      subject: string | null;
      updated_at: number;
      created_at: number;
    }>;

    for (const row of sessionRows) {
      const rawChatId = row.last_to ?? row.group_id;
      if (!rawChatId) continue;
      const chat = upsertChat(database, {
        channel: row.last_channel ?? row.channel ?? "unknown",
        instanceId: row.last_account_id ?? row.account_id ?? "",
        platformChatId: rawChatId,
        chatType: inferChatType(rawChatId, row.chat_type as ChatType | null),
        title: row.display_name ?? row.subject,
        rawProvenance: {
          sourceTable: "sessions",
          sessionKey: row.session_key,
          groupId: row.group_id,
          lastTo: row.last_to,
          lastThreadId: row.last_thread_id,
        },
        seenAt: row.updated_at || row.created_at || now,
      });
      bindSessionToChat(database, {
        sessionKey: row.session_key,
        chatId: chat.id,
        agentId: row.agent_id,
        bindingReason: "legacy_session_backfill",
        seenAt: row.updated_at || now,
      });
    }

    const eventRows = database
      .prepare(
        `
        SELECT DISTINCT source_channel, source_account_id, source_chat_id, source_thread_id
        FROM session_events
        WHERE source_chat_id IS NOT NULL
      `,
      )
      .all() as Array<{
      source_channel: string | null;
      source_account_id: string | null;
      source_chat_id: string;
      source_thread_id: string | null;
    }>;

    for (const row of eventRows) {
      upsertChat(database, {
        channel: row.source_channel ?? "unknown",
        instanceId: row.source_account_id ?? "",
        platformChatId: row.source_thread_id ? `${row.source_chat_id}#${row.source_thread_id}` : row.source_chat_id,
        chatType: row.source_thread_id ? "thread" : inferChatType(row.source_chat_id),
        rawProvenance: {
          sourceTable: "session_events",
          sourceChatId: row.source_chat_id,
          sourceThreadId: row.source_thread_id,
        },
        seenAt: now,
      });
    }

    const messageRows = database
      .prepare("SELECT DISTINCT chat_id FROM message_metadata WHERE chat_id IS NOT NULL")
      .all() as Array<{ chat_id: string }>;
    for (const row of messageRows) {
      upsertChat(database, {
        channel: "unknown",
        instanceId: "",
        platformChatId: row.chat_id,
        chatType: inferChatType(row.chat_id),
        rawProvenance: { sourceTable: "message_metadata", chatId: row.chat_id },
        seenAt: now,
      });
    }
  });

  txn();
}

function backfillChatModelOnce(database: Database): void {
  const existing = database.prepare("SELECT value FROM router_meta WHERE key = ?").get(IDENTITY_CHAT_BACKFILL_KEY) as
    | { value: string }
    | undefined;
  if (existing?.value === "done") {
    return;
  }

  backfillChatModel(database);
  database
    .prepare("INSERT OR REPLACE INTO router_meta (key, value, updated_at) VALUES (?, ?, ?)")
    .run(IDENTITY_CHAT_BACKFILL_KEY, "done", Date.now());
}

type ParsedBackfillParticipant = {
  id: string | null;
  platformUserId: string;
  displayName: string | null;
  role: string | null;
};

function parseParticipantsJson(raw: string | null): ParsedBackfillParticipant[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return null;
        const record = item as Record<string, unknown>;
        const platformUserId =
          typeof record.platformUserId === "string"
            ? record.platformUserId
            : typeof record.userId === "string"
              ? record.userId
              : null;
        if (!platformUserId) return null;
        return {
          id: typeof record.id === "string" ? record.id : null,
          platformUserId,
          displayName:
            typeof record.displayName === "string"
              ? record.displayName
              : typeof record.name === "string"
                ? record.name
                : null,
          role: typeof record.role === "string" ? record.role : null,
        };
      })
      .filter((item): item is ParsedBackfillParticipant => item !== null);
  } catch {
    return [];
  }
}

function normalizeParticipantRole(role: string | null | undefined): ChatParticipantRole {
  const normalized = role?.trim().toLowerCase();
  if (normalized === "admin" || normalized === "owner" || normalized === "member") return normalized;
  return "unknown";
}

// ============================================================================
// Prepared Statement Cache
// ============================================================================

interface PreparedStatements {
  insertAgent: Statement;
  updateAgent: Statement;
  updateAgentHeartbeatLastRun: Statement;
  deleteAgent: Statement;
  getAgent: Statement;
  listAgents: Statement;
  insertRoute: Statement;
  updateRoute: Statement;
  deleteRoute: Statement;
  getRoute: Statement;
  listRoutes: Statement;
  listRoutesByAccount: Statement;
  upsertSetting: Statement;
  getSetting: Statement;
  deleteSetting: Statement;
  listSettings: Statement;
  // Matrix accounts
  upsertMatrixAccount: Statement;
  getMatrixAccount: Statement;
  deleteMatrixAccount: Statement;
  listMatrixAccounts: Statement;
  touchMatrixAccount: Statement;
  // Message metadata
  upsertMessageMeta: Statement;
  getMessageMeta: Statement;
  listMessageMetaByChatId: Statement;
  cleanupMessageMeta: Statement;
  cleanupExpiredSessions: Statement;
  // Audit log
  insertAuditLog: Statement;
  // Soft-delete
  softDeleteRoute: Statement;
  restoreRoute: Statement;
  listDeletedRoutes: Statement;
  listDeletedRoutesByAccount: Statement;
  softDeleteInstance: Statement;
  restoreInstance: Statement;
  listDeletedInstances: Statement;
  // Cost events
  insertCostEvent: Statement;
  // Instances
  upsertInstance: Statement;
  getInstanceByName: Statement;
  getInstanceByInstanceId: Statement;
  listInstances: Statement;
  deleteInstance: Statement;
  updateInstance: Statement;
  // Contexts
  insertContext: Statement;
  getContextById: Statement;
  getContextByKey: Statement;
  listContexts: Statement;
  touchContext: Statement;
  revokeContext: Statement;
  updateContextCapabilities: Statement;
  deleteContext: Statement;
}

/**
 * Get prepared statements, creating them on first access.
 */
function getStatements(): PreparedStatements {
  if (routerDbState.stmts !== null) {
    return routerDbState.stmts;
  }

  const database = getDb();

  routerDbState.stmts = {
    // Agents
    insertAgent: database.prepare(`
      INSERT INTO agents (id, name, cwd, model, provider, remote, remote_user, dm_scope, system_prompt_append, debounce_ms, group_debounce_ms, matrix_account, setting_sources,
        heartbeat_enabled, heartbeat_interval_ms, heartbeat_model, heartbeat_active_start, heartbeat_active_end, heartbeat_account_id,
        spec_mode,
        contact_scope, allowed_sessions,
        agent_mode,
        defaults,
        created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updateAgent: database.prepare(`
      UPDATE agents SET
        name = ?,
        cwd = ?,
        model = ?,
        provider = ?,
        remote = ?,
        remote_user = ?,
        dm_scope = ?,
        system_prompt_append = ?,
        debounce_ms = ?,
        group_debounce_ms = ?,
        matrix_account = ?,
        setting_sources = ?,
        heartbeat_enabled = ?,
        heartbeat_interval_ms = ?,
        heartbeat_model = ?,
        heartbeat_active_start = ?,
        heartbeat_active_end = ?,
        heartbeat_account_id = ?,
        spec_mode = ?,
        contact_scope = ?,
        allowed_sessions = ?,
        agent_mode = ?,
        defaults = ?,
        updated_at = ?
      WHERE id = ?
    `),
    updateAgentHeartbeatLastRun: database.prepare(`
      UPDATE agents SET heartbeat_last_run_at = ?, updated_at = ? WHERE id = ?
    `),
    deleteAgent: database.prepare("DELETE FROM agents WHERE id = ?"),
    getAgent: database.prepare("SELECT * FROM agents WHERE id = ?"),
    listAgents: database.prepare("SELECT * FROM agents ORDER BY id"),

    // Routes
    insertRoute: database.prepare(`
      INSERT INTO routes (pattern, account_id, agent_id, dm_scope, session_name, policy, priority, channel, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updateRoute: database.prepare(`
      UPDATE routes SET
        agent_id = ?,
        dm_scope = ?,
        session_name = ?,
        policy = ?,
        priority = ?,
        channel = ?,
        updated_at = ?
      WHERE pattern = ? AND account_id = ?
    `),
    deleteRoute: database.prepare("DELETE FROM routes WHERE pattern = ? AND account_id = ?"),
    getRoute: database.prepare("SELECT * FROM routes WHERE pattern = ? AND account_id = ? AND deleted_at IS NULL"),
    listRoutes: database.prepare("SELECT * FROM routes WHERE deleted_at IS NULL ORDER BY priority DESC, id"),
    listRoutesByAccount: database.prepare(
      "SELECT * FROM routes WHERE account_id = ? AND deleted_at IS NULL ORDER BY priority DESC, id",
    ),

    // Settings
    upsertSetting: database.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `),
    getSetting: database.prepare("SELECT * FROM settings WHERE key = ?"),
    deleteSetting: database.prepare("DELETE FROM settings WHERE key = ?"),
    listSettings: database.prepare("SELECT * FROM settings ORDER BY key"),

    // Matrix accounts
    upsertMatrixAccount: database.prepare(`
      INSERT INTO matrix_accounts (username, user_id, homeserver, access_token, device_id, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET
        user_id = excluded.user_id,
        homeserver = excluded.homeserver,
        access_token = excluded.access_token,
        device_id = excluded.device_id,
        last_used_at = excluded.last_used_at
    `),
    getMatrixAccount: database.prepare("SELECT * FROM matrix_accounts WHERE username = ?"),
    deleteMatrixAccount: database.prepare("DELETE FROM matrix_accounts WHERE username = ?"),
    listMatrixAccounts: database.prepare("SELECT * FROM matrix_accounts ORDER BY username"),
    touchMatrixAccount: database.prepare("UPDATE matrix_accounts SET last_used_at = ? WHERE username = ?"),
    // Message metadata
    upsertMessageMeta: database.prepare(`
      INSERT INTO message_metadata (
        message_id, chat_id, canonical_chat_id, actor_type, contact_id, agent_id, platform_identity_id,
        raw_sender_id, normalized_sender_id, identity_confidence, identity_provenance_json,
        transcription, media_path, media_type, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET
        canonical_chat_id = COALESCE(excluded.canonical_chat_id, message_metadata.canonical_chat_id),
        actor_type = COALESCE(excluded.actor_type, message_metadata.actor_type),
        contact_id = COALESCE(excluded.contact_id, message_metadata.contact_id),
        agent_id = COALESCE(excluded.agent_id, message_metadata.agent_id),
        platform_identity_id = COALESCE(excluded.platform_identity_id, message_metadata.platform_identity_id),
        raw_sender_id = COALESCE(excluded.raw_sender_id, message_metadata.raw_sender_id),
        normalized_sender_id = COALESCE(excluded.normalized_sender_id, message_metadata.normalized_sender_id),
        identity_confidence = COALESCE(excluded.identity_confidence, message_metadata.identity_confidence),
        identity_provenance_json = COALESCE(excluded.identity_provenance_json, message_metadata.identity_provenance_json),
        transcription = COALESCE(excluded.transcription, message_metadata.transcription),
        media_path = COALESCE(excluded.media_path, message_metadata.media_path),
        media_type = COALESCE(excluded.media_type, message_metadata.media_type)
    `),
    getMessageMeta: database.prepare("SELECT * FROM message_metadata WHERE message_id = ?"),
    listMessageMetaByChatId: database.prepare(
      "SELECT * FROM message_metadata WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?",
    ),
    cleanupMessageMeta: database.prepare("DELETE FROM message_metadata WHERE created_at < ?"),
    cleanupExpiredSessions: database.prepare(
      "DELETE FROM sessions WHERE ephemeral = 1 AND expires_at IS NOT NULL AND expires_at <= ?",
    ),
    // Audit log
    insertAuditLog: database.prepare(
      "INSERT INTO audit_log (action, entity, entity_id, old_value, actor, ts) VALUES (?, ?, ?, ?, ?, ?)",
    ),
    // Soft-delete: routes
    softDeleteRoute: database.prepare(
      "UPDATE routes SET deleted_at = ? WHERE pattern = ? AND account_id = ? AND deleted_at IS NULL",
    ),
    restoreRoute: database.prepare("UPDATE routes SET deleted_at = NULL WHERE pattern = ? AND account_id = ?"),
    listDeletedRoutes: database.prepare("SELECT * FROM routes WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC"),
    listDeletedRoutesByAccount: database.prepare(
      "SELECT * FROM routes WHERE account_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC",
    ),
    // Soft-delete: instances
    softDeleteInstance: database.prepare("UPDATE instances SET deleted_at = ? WHERE name = ? AND deleted_at IS NULL"),
    restoreInstance: database.prepare("UPDATE instances SET deleted_at = NULL WHERE name = ?"),
    listDeletedInstances: database.prepare(
      "SELECT * FROM instances WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC",
    ),
    // Cost events
    insertCostEvent: database.prepare(`
      INSERT INTO cost_events (session_key, agent_id, model, input_tokens, output_tokens,
        cache_read_tokens, cache_creation_tokens, input_cost_usd, output_cost_usd, cache_cost_usd,
        total_cost_usd, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    // Instances
    upsertInstance: database.prepare(`
      INSERT INTO instances (name, instance_id, channel, agent, dm_policy, group_policy, dm_scope, enabled, defaults, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        instance_id  = excluded.instance_id,
        channel      = excluded.channel,
        agent        = excluded.agent,
        dm_policy    = excluded.dm_policy,
        group_policy = excluded.group_policy,
        dm_scope     = excluded.dm_scope,
        enabled      = excluded.enabled,
        defaults     = excluded.defaults,
        updated_at   = excluded.updated_at
    `),
    getInstanceByName: database.prepare("SELECT * FROM instances WHERE name = ? AND deleted_at IS NULL"),
    getInstanceByInstanceId: database.prepare("SELECT * FROM instances WHERE instance_id = ? AND deleted_at IS NULL"),
    listInstances: database.prepare("SELECT * FROM instances WHERE deleted_at IS NULL ORDER BY name"),
    deleteInstance: database.prepare("DELETE FROM instances WHERE name = ?"),
    updateInstance: database.prepare(`
      UPDATE instances SET
        instance_id  = ?,
        channel      = ?,
        agent        = ?,
        dm_policy    = ?,
        group_policy = ?,
        dm_scope     = ?,
        enabled      = ?,
        defaults     = ?,
        updated_at   = ?
      WHERE name = ?
    `),
    // Contexts
    insertContext: database.prepare(`
      INSERT INTO contexts (
        context_id, context_key, kind, agent_id, session_key, session_name,
        source_json, capabilities_json, metadata_json, created_at, expires_at, last_used_at, revoked_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    getContextById: database.prepare("SELECT * FROM contexts WHERE context_id = ?"),
    getContextByKey: database.prepare("SELECT * FROM contexts WHERE context_key = ?"),
    listContexts: database.prepare("SELECT * FROM contexts ORDER BY created_at DESC"),
    touchContext: database.prepare("UPDATE contexts SET last_used_at = ? WHERE context_id = ?"),
    revokeContext: database.prepare("UPDATE contexts SET revoked_at = ? WHERE context_id = ?"),
    updateContextCapabilities: database.prepare(`
      UPDATE contexts SET
        capabilities_json = ?,
        last_used_at = ?
      WHERE context_id = ?
    `),
    deleteContext: database.prepare("DELETE FROM contexts WHERE context_id = ?"),
  };

  return routerDbState.stmts!;
}

// ============================================================================
// Row Mapping
// ============================================================================

function rowToAgent(row: AgentRow): AgentConfig {
  const result: AgentConfig = {
    id: row.id,
    cwd: row.cwd,
  };

  if (row.name !== null) result.name = row.name;
  if (row.model !== null) result.model = row.model;
  if (row.provider !== null) result.provider = row.provider;
  if (row.remote !== null) result.remote = row.remote;
  if (row.remote_user !== null) result.remoteUser = row.remote_user;
  if (row.dm_scope !== null) {
    // Validate before casting
    const parsed = DmScopeSchema.safeParse(row.dm_scope);
    if (parsed.success) {
      result.dmScope = parsed.data;
    }
  }
  if (row.system_prompt_append !== null) result.systemPromptAppend = row.system_prompt_append;
  if (row.debounce_ms !== null) result.debounceMs = row.debounce_ms;
  if (row.group_debounce_ms !== null) result.groupDebounceMs = row.group_debounce_ms;
  if (row.matrix_account !== null) result.matrixAccount = row.matrix_account;
  if (row.setting_sources !== null) {
    try {
      result.settingSources = JSON.parse(row.setting_sources);
    } catch {
      // Ignore invalid JSON
    }
  }

  // Heartbeat fields
  result.heartbeat = {
    enabled: row.heartbeat_enabled === 1,
    intervalMs: row.heartbeat_interval_ms ?? 1800000,
    model: row.heartbeat_model ?? undefined,
    accountId: row.heartbeat_account_id ?? undefined,
    activeStart: row.heartbeat_active_start ?? undefined,
    activeEnd: row.heartbeat_active_end ?? undefined,
    lastRunAt: row.heartbeat_last_run_at ?? undefined,
  };

  // Spec mode
  result.specMode = row.spec_mode === 1;

  // Scope isolation
  if (row.contact_scope !== null) result.contactScope = row.contact_scope;
  if (row.allowed_sessions !== null) {
    try {
      result.allowedSessions = JSON.parse(row.allowed_sessions);
    } catch {
      // Ignore invalid JSON
    }
  }

  // Agent mode
  if (row.agent_mode === "active" || row.agent_mode === "sentinel") {
    result.mode = row.agent_mode;
  }

  // Generic defaults
  if (row.defaults !== null) {
    try {
      result.defaults = JSON.parse(row.defaults);
    } catch {
      // Ignore invalid JSON
    }
  }

  return result;
}

function rowToRoute(row: RouteRow): RouteConfig & { id: number } {
  const result: RouteConfig & { id: number } = {
    id: row.id,
    pattern: row.pattern,
    accountId: row.account_id,
    agent: row.agent_id,
    priority: row.priority,
  };

  if (row.dm_scope !== null) {
    const parsed = DmScopeSchema.safeParse(row.dm_scope);
    if (parsed.success) {
      result.dmScope = parsed.data;
    }
  }

  if (row.session_name !== null) {
    result.session = row.session_name;
  }

  if ((row as RouteRow & { policy?: string | null }).policy != null) {
    result.policy = (row as RouteRow & { policy?: string | null }).policy!;
  }

  if (row.channel !== null) {
    result.channel = row.channel;
  }

  return result;
}

function rowToInstance(row: InstanceRow): InstanceConfig {
  const result: InstanceConfig = {
    name: row.name,
    channel: row.channel,
    dmPolicy: (row.dm_policy ?? "open") as InstanceConfig["dmPolicy"],
    groupPolicy: (row.group_policy ?? "open") as InstanceConfig["groupPolicy"],
    enabled: row.enabled !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.instance_id) result.instanceId = row.instance_id;
  if (row.agent) result.agent = row.agent;
  if (row.dm_scope) {
    const parsed = DmScopeSchema.safeParse(row.dm_scope);
    if (parsed.success) result.dmScope = parsed.data;
  }
  if (row.defaults) {
    try {
      result.defaults = JSON.parse(row.defaults);
    } catch {
      // Ignore invalid JSON so a bad defaults blob does not break instance listing.
    }
  }
  if (row.deleted_at) result.deletedAt = row.deleted_at;
  return result;
}

function rowToContext(row: ContextRow): ContextRecord {
  const result: ContextRecord = {
    contextId: row.context_id,
    contextKey: row.context_key,
    kind: row.kind,
    capabilities: [],
    createdAt: row.created_at,
  };

  if (row.agent_id) result.agentId = row.agent_id;
  if (row.session_key) result.sessionKey = row.session_key;
  if (row.session_name) result.sessionName = row.session_name;
  if (row.expires_at) result.expiresAt = row.expires_at;
  if (row.last_used_at) result.lastUsedAt = row.last_used_at;
  if (row.revoked_at) result.revokedAt = row.revoked_at;

  if (row.source_json) {
    try {
      const parsed = ContextSourceSchema.safeParse(JSON.parse(row.source_json));
      if (parsed.success) result.source = parsed.data;
    } catch {
      // Ignore invalid JSON
    }
  }

  try {
    const parsed = z.array(ContextCapabilitySchema).safeParse(JSON.parse(row.capabilities_json));
    if (parsed.success) result.capabilities = parsed.data;
  } catch {
    // Ignore invalid JSON
  }

  if (row.metadata_json) {
    try {
      const parsed = z.record(z.string(), z.unknown()).safeParse(JSON.parse(row.metadata_json));
      if (parsed.success) result.metadata = parsed.data;
    } catch {
      // Ignore invalid JSON
    }
  }

  return result;
}

export function dbUpsertChat(input: UpsertChatInput): ChatRecord {
  return upsertChat(getDb(), input);
}

export function dbGetChat(id: string): ChatRecord | null {
  const row = getDb().prepare("SELECT * FROM chats WHERE id = ?").get(id) as ChatRow | undefined;
  return row ? rowToChat(row) : null;
}

export function dbFindChat(input: {
  channel: string;
  instanceId?: string | null;
  platformChatId: string;
  chatType?: ChatType;
}): ChatRecord | null {
  const channel = normalizeChannelId(input.channel);
  const instanceId = input.instanceId?.trim() ?? "";
  const normalizedChatId = normalizeChatIdentity(channel, input.platformChatId, input.chatType);
  const row = getDb()
    .prepare("SELECT * FROM chats WHERE channel = ? AND instance_id = ? AND normalized_chat_id = ?")
    .get(channel, instanceId, normalizedChatId) as ChatRow | undefined;
  return row ? rowToChat(row) : null;
}

export function dbUpsertChatParticipant(input: UpsertChatParticipantInput): ChatParticipantRecord {
  return upsertChatParticipant(getDb(), input);
}

export function dbListChatParticipants(chatId: string): ChatParticipantRecord[] {
  const rows = getDb()
    .prepare("SELECT * FROM chat_participants WHERE chat_id = ? ORDER BY role, normalized_platform_user_id, id")
    .all(chatId) as ChatParticipantRow[];
  return rows.map(rowToChatParticipant);
}

export function dbBindSessionToChat(input: {
  sessionKey: string;
  chatId: string;
  agentId?: string | null;
  routeId?: number | null;
  bindingReason?: string | null;
  seenAt?: number;
}): SessionChatBindingRecord {
  return bindSessionToChat(getDb(), input);
}

export function dbGetSessionChatBinding(sessionKey: string): SessionChatBindingRecord | null {
  const row = getDb().prepare("SELECT * FROM session_chat_bindings WHERE session_key = ?").get(sessionKey) as
    | SessionChatBindingRow
    | undefined;
  return row ? rowToSessionChatBinding(row) : null;
}

export function dbListSessionChatBindings(chatId: string): SessionChatBindingRecord[] {
  const rows = getDb()
    .prepare("SELECT * FROM session_chat_bindings WHERE chat_id = ? ORDER BY updated_at DESC")
    .all(chatId) as SessionChatBindingRow[];
  return rows.map(rowToSessionChatBinding);
}

export function dbUpsertSessionParticipant(input: UpsertSessionParticipantInput): SessionParticipantRecord {
  return upsertSessionParticipant(getDb(), input);
}

export function dbListSessionParticipants(sessionKey: string): SessionParticipantRecord[] {
  const rows = getDb()
    .prepare("SELECT * FROM session_participants WHERE session_key = ? ORDER BY last_seen_at DESC")
    .all(sessionKey) as SessionParticipantRow[];
  return rows.map(rowToSessionParticipant);
}

export function dbBackfillChatModel(): void {
  backfillChatModel(getDb());
}

// ============================================================================
// Agent CRUD
// ============================================================================

/**
 * Create a new agent
 */
export function dbCreateAgent(input: z.input<typeof AgentInputSchema>): AgentConfig {
  const validated = AgentInputSchema.parse(input);
  const now = Date.now();
  const s = getStatements();

  // Verify matrix account exists if specified
  if (validated.matrixAccount) {
    const account = dbGetMatrixAccount(validated.matrixAccount);
    if (!account) {
      throw new Error(`Matrix account not found: ${validated.matrixAccount}`);
    }
  }

  try {
    s.insertAgent.run(
      validated.id,
      validated.name ?? null,
      validated.cwd,
      validated.model ?? null,
      validated.provider ?? null,
      validated.remote ?? null,
      validated.remoteUser ?? null,
      validated.dmScope ?? null,
      validated.systemPromptAppend ?? null,
      validated.debounceMs ?? null,
      validated.groupDebounceMs ?? null,
      validated.matrixAccount ?? null,
      validated.settingSources ? JSON.stringify(validated.settingSources) : null,
      // Heartbeat fields (defaults)
      0, // heartbeat_enabled
      1800000, // heartbeat_interval_ms (30 min)
      null, // heartbeat_model
      null, // heartbeat_active_start
      null, // heartbeat_active_end
      null, // heartbeat_account_id
      0, // spec_mode (disabled by default)
      null, // contact_scope (no restriction by default)
      null, // allowed_sessions (no cross-session by default)
      validated.mode ?? null, // agent_mode
      null, // defaults
      now,
      now,
    );

    log.info("Created agent", { id: validated.id });
    return dbGetAgent(validated.id)!;
  } catch (err) {
    if ((err as Error).message.includes("UNIQUE constraint failed")) {
      throw new Error(`Agent already exists: ${validated.id}`);
    }
    throw err;
  }
}

/**
 * Get agent by ID
 */
export function dbGetAgent(id: string): AgentConfig | null {
  const s = getStatements();
  const row = s.getAgent.get(id) as AgentRow | undefined;
  return row ? rowToAgent(row) : null;
}

/**
 * List all agents
 */
export function dbListAgents(): AgentConfig[] {
  const s = getStatements();
  const rows = s.listAgents.all() as AgentRow[];
  return rows.map(rowToAgent);
}

/**
 * Update an existing agent
 */
export function dbUpdateAgent(id: string, updates: Partial<AgentConfig>): AgentConfig {
  const s = getStatements();
  const row = s.getAgent.get(id) as AgentRow | undefined;

  if (!row) {
    throw new Error(`Agent not found: ${id}`);
  }

  // Validate dmScope if provided
  if (updates.dmScope !== undefined) {
    DmScopeSchema.parse(updates.dmScope);
  }

  // Verify matrix account exists if specified
  if (updates.matrixAccount !== undefined && updates.matrixAccount !== null) {
    const account = dbGetMatrixAccount(updates.matrixAccount);
    if (!account) {
      throw new Error(`Matrix account not found: ${updates.matrixAccount}`);
    }
  }

  const now = Date.now();
  const hb = updates.heartbeat;
  s.updateAgent.run(
    updates.name !== undefined ? (updates.name ?? null) : row.name,
    updates.cwd ?? row.cwd,
    updates.model !== undefined ? (updates.model ?? null) : row.model,
    updates.provider !== undefined ? (updates.provider ?? null) : row.provider,
    updates.remote !== undefined ? (updates.remote ?? null) : row.remote,
    updates.remoteUser !== undefined ? (updates.remoteUser ?? null) : row.remote_user,
    updates.dmScope !== undefined ? (updates.dmScope ?? null) : row.dm_scope,
    updates.systemPromptAppend !== undefined ? (updates.systemPromptAppend ?? null) : row.system_prompt_append,
    updates.debounceMs !== undefined ? (updates.debounceMs ?? null) : row.debounce_ms,
    updates.groupDebounceMs !== undefined ? (updates.groupDebounceMs ?? null) : row.group_debounce_ms,
    updates.matrixAccount !== undefined ? (updates.matrixAccount ?? null) : row.matrix_account,
    updates.settingSources !== undefined
      ? updates.settingSources
        ? JSON.stringify(updates.settingSources)
        : null
      : row.setting_sources,
    // Heartbeat fields
    hb?.enabled !== undefined ? (hb.enabled ? 1 : 0) : row.heartbeat_enabled,
    hb?.intervalMs !== undefined ? hb.intervalMs : row.heartbeat_interval_ms,
    hb?.model !== undefined ? (hb.model ?? null) : row.heartbeat_model,
    hb?.activeStart !== undefined ? (hb.activeStart ?? null) : row.heartbeat_active_start,
    hb?.activeEnd !== undefined ? (hb.activeEnd ?? null) : row.heartbeat_active_end,
    hb?.accountId !== undefined ? (hb.accountId ?? null) : row.heartbeat_account_id,
    // Spec mode
    updates.specMode !== undefined ? (updates.specMode ? 1 : 0) : row.spec_mode,
    // Scope isolation
    updates.contactScope !== undefined ? (updates.contactScope ?? null) : row.contact_scope,
    updates.allowedSessions !== undefined
      ? updates.allowedSessions
        ? JSON.stringify(updates.allowedSessions)
        : null
      : row.allowed_sessions,
    // Agent mode
    updates.mode !== undefined ? (updates.mode ?? null) : row.agent_mode,
    // Generic defaults
    updates.defaults !== undefined ? (updates.defaults ? JSON.stringify(updates.defaults) : null) : row.defaults,
    now,
    id,
  );

  log.info("Updated agent", { id });
  return dbGetAgent(id)!;
}

/**
 * Update agent's heartbeat last run timestamp
 */
export function dbUpdateAgentHeartbeatLastRun(id: string): void {
  const s = getStatements();
  const now = Date.now();
  s.updateAgentHeartbeatLastRun.run(now, now, id);
}

/**
 * Delete an agent
 */
export function dbDeleteAgent(id: string): boolean {
  // Cannot delete the default agent
  const defaultAgentId = getDefaultAgentId();
  if (id === defaultAgentId) {
    throw new Error(`Cannot delete default agent: ${id}`);
  }

  const s = getStatements();
  s.deleteAgent.run(id);
  if (getDbChanges() > 0) {
    log.info("Deleted agent", { id });
    return true;
  }
  return false;
}

/**
 * Set debounce time for an agent (null = disable debounce)
 */
export function dbSetAgentDebounce(id: string, debounceMs: number | null): void {
  dbUpdateAgent(id, { debounceMs: debounceMs as number | undefined });
  log.info("Set agent debounce", { id, debounceMs });
}

// ============================================================================
// Agent Spec Mode
// ============================================================================

/**
 * Enable or disable spec mode for an agent
 */
export function dbSetAgentSpecMode(id: string, enabled: boolean): void {
  dbUpdateAgent(id, { specMode: enabled });
  log.info("Set agent spec mode", { id, enabled });
}

// ============================================================================
// Route CRUD
// ============================================================================

/**
 * Create a new route
 */
export function dbCreateRoute(input: z.input<typeof RouteInputSchema>): RouteConfig {
  const validated = RouteInputSchema.parse(input);
  const s = getStatements();

  // Verify agent exists
  if (!dbGetAgent(validated.agent)) {
    throw new Error(`Agent not found: ${validated.agent}`);
  }

  const now = Date.now();
  const normalizedPattern = validated.pattern.toLowerCase();

  try {
    s.insertRoute.run(
      normalizedPattern,
      validated.accountId,
      validated.agent,
      validated.dmScope ?? null,
      validated.session ?? null,
      validated.policy ?? null,
      validated.priority,
      validated.channel ?? null,
      now,
      now,
    );

    log.info("Created route", {
      pattern: normalizedPattern,
      account: validated.accountId,
      agent: validated.agent,
      channel: validated.channel ?? "*",
    });
    return dbGetRoute(normalizedPattern, validated.accountId)!;
  } catch (err) {
    if ((err as Error).message.includes("UNIQUE constraint failed")) {
      const channelSuffix = validated.channel ? ` [${validated.channel}]` : "";
      throw new Error(`Route already exists: ${validated.pattern} (account: ${validated.accountId}${channelSuffix})`);
    }
    throw err;
  }
}

/**
 * Get route by pattern and account
 */
export function dbGetRoute(pattern: string, accountId: string): (RouteConfig & { id: number }) | null {
  const s = getStatements();
  const row = s.getRoute.get(pattern, accountId) as RouteRow | undefined;
  return row ? rowToRoute(row) : null;
}

/**
 * List routes, optionally filtered by account
 */
export function dbListRoutes(accountId?: string): (RouteConfig & { id: number })[] {
  const s = getStatements();
  const rows = accountId ? (s.listRoutesByAccount.all(accountId) as RouteRow[]) : (s.listRoutes.all() as RouteRow[]);
  return rows.map(rowToRoute);
}

/**
 * List active routes that force a specific session name.
 */
export function dbListRoutesBySessionName(sessionName: string): (RouteConfig & { id: number })[] {
  const rows = getDb()
    .prepare("SELECT * FROM routes WHERE session_name = ? AND deleted_at IS NULL ORDER BY priority DESC, id")
    .all(sessionName) as RouteRow[];
  return rows.map(rowToRoute);
}

/**
 * Rename active route session references after a canonical session rename.
 */
export function dbRenameRouteSessionName(oldName: string, newName: string): number {
  getDb()
    .prepare("UPDATE routes SET session_name = ?, updated_at = ? WHERE session_name = ? AND deleted_at IS NULL")
    .run(newName, Date.now(), oldName);
  return getDbChanges();
}

/**
 * Update an existing route
 */
export function dbUpdateRoute(pattern: string, updates: Partial<RouteConfig>, accountId: string): RouteConfig {
  const s = getStatements();
  const row = s.getRoute.get(pattern, accountId) as RouteRow | undefined;

  if (!row) {
    throw new Error(`Route not found: ${pattern} (account: ${accountId})`);
  }

  // Verify agent if updating
  if (updates.agent && !dbGetAgent(updates.agent)) {
    throw new Error(`Agent not found: ${updates.agent}`);
  }

  // Validate dmScope if provided
  if (updates.dmScope !== undefined) {
    DmScopeSchema.parse(updates.dmScope);
  }

  const now = Date.now();
  s.updateRoute.run(
    updates.agent ?? row.agent_id,
    updates.dmScope !== undefined ? (updates.dmScope ?? null) : row.dm_scope,
    updates.session !== undefined ? (updates.session ?? null) : row.session_name,
    updates.policy !== undefined ? (updates.policy ?? null) : row.policy,
    updates.priority ?? row.priority,
    updates.channel !== undefined ? (updates.channel ?? null) : row.channel,
    now,
    pattern,
    accountId,
  );

  log.info("Updated route", { pattern, accountId });
  return dbGetRoute(pattern, accountId)!;
}

/**
 * Soft-delete a route (sets deleted_at, keeps row for audit/recovery).
 */
export function dbDeleteRoute(pattern: string, accountId: string): boolean {
  const s = getStatements();
  const route = dbGetRoute(pattern, accountId);
  if (!route) return false;
  const now = Date.now();
  s.softDeleteRoute.run(now, pattern, accountId);
  if (getDbChanges() > 0) {
    s.insertAuditLog.run(
      "route.deleted",
      "route",
      `${pattern}@${accountId}`,
      JSON.stringify(route),
      process.env.USER ?? "daemon",
      now,
    );
    log.info("Soft-deleted route", { pattern, accountId });
    return true;
  }
  return false;
}

/**
 * Restore a soft-deleted route.
 */
export function dbRestoreRoute(pattern: string, accountId: string): boolean {
  const s = getStatements();
  const now = Date.now();
  s.restoreRoute.run(pattern, accountId);
  if (getDbChanges() > 0) {
    s.insertAuditLog.run("route.restored", "route", `${pattern}@${accountId}`, null, process.env.USER ?? "daemon", now);
    log.info("Restored route", { pattern, accountId });
    return true;
  }
  return false;
}

/**
 * List soft-deleted routes (for recovery/audit).
 */
export function dbListDeletedRoutes(accountId?: string): RouteConfig[] {
  const s = getStatements();
  const rows = (accountId ? s.listDeletedRoutesByAccount.all(accountId) : s.listDeletedRoutes.all()) as RouteRow[];
  return rows.map(rowToRoute);
}

// ============================================================================
// Settings
// ============================================================================

/**
 * Get a setting value
 */
export function dbGetSetting(key: string): string | null {
  const s = getStatements();
  const row = s.getSetting.get(key) as SettingRow | undefined;
  return row?.value ?? null;
}

/**
 * Set a setting value
 */
export function dbSetSetting(key: string, value: string): void {
  // Validate specific settings
  if (key === "defaultDmScope") {
    DmScopeSchema.parse(value);
  }
  if (key === "defaultAgent") {
    if (!dbGetAgent(value)) {
      throw new Error(`Agent not found: ${value}`);
    }
  }

  const s = getStatements();
  const now = Date.now();
  s.upsertSetting.run(key, value, now);
  log.info("Set setting", { key, value });
}

/**
 * Delete a setting
 */
export function dbDeleteSetting(key: string): boolean {
  const s = getStatements();
  s.deleteSetting.run(key);
  return getDbChanges() > 0;
}

/**
 * List all settings
 */
export function dbListSettings(): Record<string, string> {
  const s = getStatements();
  const rows = s.listSettings.all() as SettingRow[];
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

// ============================================================================
// Instance CRUD
// ============================================================================

export function dbUpsertInstance(input: z.input<typeof InstanceInputSchema>): InstanceConfig {
  const validated = InstanceInputSchema.parse(input);
  if (validated.agent && !dbGetAgent(validated.agent)) {
    throw new Error(`Agent not found: ${validated.agent}`);
  }
  const s = getStatements();
  const now = Date.now();
  s.upsertInstance.run(
    validated.name,
    validated.instanceId ?? null,
    validated.channel,
    validated.agent ?? null,
    validated.dmPolicy,
    validated.groupPolicy,
    validated.dmScope ?? null,
    validated.enabled ? 1 : 0,
    validated.defaults ? JSON.stringify(validated.defaults) : null,
    now,
    now,
  );
  log.info("Upserted instance", { name: validated.name });
  return dbGetInstance(validated.name)!;
}

export function dbGetInstance(name: string): InstanceConfig | null {
  const s = getStatements();
  const row = s.getInstanceByName.get(name) as InstanceRow | undefined;
  return row ? rowToInstance(row) : null;
}

export function dbGetInstanceByInstanceId(instanceId: string): InstanceConfig | null {
  const s = getStatements();
  const row = s.getInstanceByInstanceId.get(instanceId) as InstanceRow | undefined;
  return row ? rowToInstance(row) : null;
}

export function dbListInstances(): InstanceConfig[] {
  const s = getStatements();
  const rows = s.listInstances.all() as InstanceRow[];
  return rows.map(rowToInstance);
}

export function dbUpdateInstance(
  name: string,
  updates: Partial<Omit<InstanceConfig, "name" | "createdAt" | "updatedAt" | "defaults">> & {
    defaults?: Record<string, unknown> | null;
  },
): InstanceConfig {
  const s = getStatements();
  const row = s.getInstanceByName.get(name) as InstanceRow | undefined;
  if (!row) throw new Error(`Instance not found: ${name}`);
  if (updates.agent && !dbGetAgent(updates.agent)) {
    throw new Error(`Agent not found: ${updates.agent}`);
  }
  if (updates.dmScope) DmScopeSchema.parse(updates.dmScope);
  if (updates.dmPolicy) DmPolicySchema.parse(updates.dmPolicy);
  if (updates.groupPolicy) GroupPolicySchema.parse(updates.groupPolicy);
  const now = Date.now();
  s.updateInstance.run(
    updates.instanceId !== undefined ? (updates.instanceId ?? null) : row.instance_id,
    updates.channel ?? row.channel,
    updates.agent !== undefined ? (updates.agent ?? null) : row.agent,
    updates.dmPolicy ?? row.dm_policy,
    updates.groupPolicy ?? row.group_policy,
    updates.dmScope !== undefined ? (updates.dmScope ?? null) : row.dm_scope,
    updates.enabled !== undefined ? (updates.enabled ? 1 : 0) : (row.enabled ?? 1),
    updates.defaults !== undefined ? (updates.defaults ? JSON.stringify(updates.defaults) : null) : row.defaults,
    now,
    name,
  );
  log.info("Updated instance", { name, ...updates });
  return dbGetInstance(name)!;
}

/**
 * Soft-delete an instance (sets deleted_at, keeps row for audit/recovery).
 */
export function dbDeleteInstance(name: string): boolean {
  const s = getStatements();
  const inst = dbGetInstance(name);
  if (!inst) return false;
  const now = Date.now();
  s.softDeleteInstance.run(now, name);
  if (getDbChanges() > 0) {
    s.insertAuditLog.run("instance.deleted", "instance", name, JSON.stringify(inst), process.env.USER ?? "daemon", now);
    log.info("Soft-deleted instance", { name });
    return true;
  }
  return false;
}

/**
 * Restore a soft-deleted instance.
 */
export function dbRestoreInstance(name: string): boolean {
  const s = getStatements();
  const now = Date.now();
  s.restoreInstance.run(name);
  if (getDbChanges() > 0) {
    s.insertAuditLog.run("instance.restored", "instance", name, null, process.env.USER ?? "daemon", now);
    log.info("Restored instance", { name });
    return true;
  }
  return false;
}

/**
 * List soft-deleted instances (for recovery/audit).
 */
export function dbListDeletedInstances(): InstanceConfig[] {
  const s = getStatements();
  return (s.listDeletedInstances.all() as InstanceRow[]).map(rowToInstance);
}

// ============================================================================
// Context Registry
// ============================================================================

export function dbCreateContext(input: z.input<typeof ContextInputSchema>): ContextRecord {
  const validated = ContextInputSchema.parse(input);
  if (validated.agentId && !dbGetAgent(validated.agentId)) {
    throw new Error(`Agent not found: ${validated.agentId}`);
  }

  const s = getStatements();
  const createdAt = validated.createdAt ?? Date.now();

  try {
    s.insertContext.run(
      validated.contextId,
      validated.contextKey,
      validated.kind,
      validated.agentId ?? null,
      validated.sessionKey ?? null,
      validated.sessionName ?? null,
      validated.source ? JSON.stringify(validated.source) : null,
      JSON.stringify(validated.capabilities),
      validated.metadata ? JSON.stringify(validated.metadata) : null,
      createdAt,
      validated.expiresAt ?? null,
      validated.lastUsedAt ?? null,
      validated.revokedAt ?? null,
    );
  } catch (err) {
    if ((err as Error).message.includes("UNIQUE constraint failed")) {
      throw new Error(`Context already exists: ${validated.contextId}`);
    }
    throw err;
  }

  return dbGetContext(validated.contextId)!;
}

export function dbGetContext(contextId: string): ContextRecord | null {
  const s = getStatements();
  const row = s.getContextById.get(contextId) as ContextRow | undefined;
  return row ? rowToContext(row) : null;
}

export function dbGetContextByKey(contextKey: string): ContextRecord | null {
  const s = getStatements();
  const row = s.getContextByKey.get(contextKey) as ContextRow | undefined;
  return row ? rowToContext(row) : null;
}

export function dbGetContextByKeyReadOnly(contextKey: string): ContextRecord | null {
  const dbPath = resolveDbPath();
  if (!existsSync(dbPath)) return null;

  const db = new Database(dbPath, { readonly: true, create: false });
  try {
    db.exec("PRAGMA busy_timeout = 1000");
    const row = db.prepare("SELECT * FROM contexts WHERE context_key = ?").get(contextKey) as ContextRow | undefined;
    return row ? rowToContext(row) : null;
  } catch (error) {
    if (error instanceof Error && /no such table: contexts/i.test(error.message)) {
      return null;
    }
    throw error;
  } finally {
    db.close();
  }
}

export function dbListContexts(options: ListContextsOptions = {}): ContextRecord[] {
  const s = getStatements();
  const now = Date.now();
  const rows = s.listContexts.all() as ContextRow[];

  return rows
    .map((row) => rowToContext(row))
    .filter((context) => {
      if (options.agentId && context.agentId !== options.agentId) return false;
      if (options.sessionKey && context.sessionKey !== options.sessionKey) return false;
      if (options.kind && context.kind !== options.kind) return false;

      if (!options.includeInactive) {
        if (context.revokedAt && context.revokedAt <= now) return false;
        if (context.expiresAt && context.expiresAt <= now) return false;
      }

      return true;
    });
}

export function dbTouchContext(contextId: string, lastUsedAt = Date.now()): void {
  const s = getStatements();
  s.touchContext.run(lastUsedAt, contextId);
}

export interface RevokeContextOptions {
  revokedAt?: number;
  cascade?: boolean;
  reason?: string;
}

export interface RevokeContextResult {
  context: ContextRecord;
  cascaded: ContextRecord[];
  revokedAt: number;
}

/**
 * Revoke a context. By default cascades to all descendants (children whose
 * `metadata.parentContextId` chains back to this context) within one
 * transaction; the same `revokedAt` timestamp is applied to every record.
 *
 * Pass `cascade: false` only when rotating a parent without invalidating
 * already-issued workers. The CLI surface should require an opt-in flag and
 * emit a warning before calling this with cascade disabled.
 */
export function dbRevokeContextCascade(contextId: string, options: RevokeContextOptions = {}): RevokeContextResult {
  const root = dbGetContext(contextId);
  if (!root) {
    throw new Error(`Context not found: ${contextId}`);
  }
  const revokedAt = options.revokedAt ?? Date.now();
  const cascade = options.cascade !== false;
  const s = getStatements();

  const targets: ContextRecord[] = [root];
  if (cascade) {
    const allRows = s.listContexts.all() as ContextRow[];
    const all = allRows.map((row) => rowToContext(row));
    const childrenByParent = new Map<string, ContextRecord[]>();
    for (const ctx of all) {
      const parentId = typeof ctx.metadata?.parentContextId === "string" ? ctx.metadata.parentContextId : null;
      if (!parentId) continue;
      const list = childrenByParent.get(parentId) ?? [];
      list.push(ctx);
      childrenByParent.set(parentId, list);
    }

    const visited = new Set<string>([root.contextId]);
    const queue: string[] = [root.contextId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const children = childrenByParent.get(current) ?? [];
      for (const child of children) {
        if (visited.has(child.contextId)) continue;
        visited.add(child.contextId);
        targets.push(child);
        queue.push(child.contextId);
      }
    }
  }

  const db = getDb();
  const reasonNote = options.reason?.trim();
  const reasonKey = "revocationReason";
  const cascadeKey = "cascadedFrom";
  const cascadeFlagKey = "revokedViaCascade";
  const cascadeRootKey = "cascadeRootContextId";

  db.transaction(() => {
    for (const target of targets) {
      // Skip if already revoked at the same or earlier timestamp (idempotency).
      if (target.revokedAt && target.revokedAt <= revokedAt) {
        // Still update metadata if a reason or cascade flag should be set.
      }
      const metadata: Record<string, unknown> = { ...(target.metadata ?? {}) };
      if (reasonNote) {
        metadata[reasonKey] = reasonNote;
      }
      if (target.contextId !== root.contextId) {
        metadata[cascadeFlagKey] = true;
        metadata[cascadeRootKey] = root.contextId;
        const chain = Array.isArray(metadata[cascadeKey]) ? (metadata[cascadeKey] as unknown[]) : [];
        if (!chain.includes(root.contextId)) {
          chain.push(root.contextId);
        }
        metadata[cascadeKey] = chain;
      }

      db.prepare(`UPDATE contexts SET revoked_at = ?, metadata_json = ? WHERE context_id = ?`).run(
        revokedAt,
        JSON.stringify(metadata),
        target.contextId,
      );
    }
  })();

  const finalRoot = dbGetContext(contextId)!;
  const cascaded: ContextRecord[] = [];
  for (const target of targets) {
    if (target.contextId === root.contextId) continue;
    const refreshed = dbGetContext(target.contextId);
    if (refreshed) cascaded.push(refreshed);
  }
  return { context: finalRoot, cascaded, revokedAt };
}

export function dbRevokeContext(contextId: string, revokedAt = Date.now()): ContextRecord {
  const result = dbRevokeContextCascade(contextId, { revokedAt, cascade: false });
  return result.context;
}

export function dbUpdateContextCapabilities(contextId: string, capabilities: ContextCapability[]): ContextRecord {
  const s = getStatements();
  if (!dbGetContext(contextId)) {
    throw new Error(`Context not found: ${contextId}`);
  }
  const validated = z.array(ContextCapabilitySchema).parse(capabilities);
  s.updateContextCapabilities.run(JSON.stringify(validated), Date.now(), contextId);
  return dbGetContext(contextId)!;
}

export function dbDeleteContext(contextId: string): boolean {
  const s = getStatements();
  s.deleteContext.run(contextId);
  return getDbChanges() > 0;
}

// ============================================================================
// Convenience Getters
// ============================================================================

/**
 * Get default agent ID
 */
export function getDefaultAgentId(): string {
  return dbGetSetting("defaultAgent") ?? "main";
}

/**
 * Get default DM scope
 */
export function getDefaultDmScope(): DmScope {
  const value = dbGetSetting("defaultDmScope");
  if (value === null) {
    return "per-peer";
  }
  const parsed = DmScopeSchema.safeParse(value);
  return parsed.success ? parsed.data : "per-peer";
}

/**
 * Get default timezone for cron jobs
 */
export function getDefaultTimezone(): string | undefined {
  return dbGetSetting("defaultTimezone") ?? undefined;
}

/**
 * Get the first registered instance name.
 */
export function getFirstAccountName(): string | undefined {
  const instances = dbListInstances();
  return instances.find((instance) => instance.enabled !== false)?.name;
}

/**
 * Get the instance name mapped to a specific agent.
 * Falls back to first instance name if no mapping found.
 */
export function getAccountForAgent(agentId: string): string | undefined {
  const instances = dbListInstances();
  return (
    instances.find((instance) => instance.enabled !== false && instance.agent === agentId)?.name ??
    instances.find((instance) => instance.enabled !== false)?.name
  );
}

/**
 * Whether to announce compaction start/end to the active session's channel.
 * Setting value: "true" or "false" (default: "true")
 */
export function getAnnounceCompaction(): boolean {
  return dbGetSetting("announceCompaction") !== "false";
}

// ============================================================================
// Database Management
// ============================================================================

/**
 * Close the database connection
 */
export function closeRouterDb(): void {
  if (routerDbState.db !== null) {
    routerDbState.db.close();
    routerDbState.db = null;
    routerDbState.stmts = null;
    routerDbState.dbPath = null;
  }
}

/**
 * Get the shared database connection (for sessions.ts)
 */
export { getDb, getDbChanges };

/**
 * Get the database path
 */
export function getRaviDbPath(): string {
  return resolveDbPath();
}

/**
 * Get the ravi directory
 */
export function getRaviDir(): string {
  return getRaviStateDir();
}

// ============================================================================
// Matrix Accounts (all Matrix users - both regular users and agents)
// ============================================================================

function rowToMatrixAccount(row: MatrixAccountRow): MatrixAccount {
  const result: MatrixAccount = {
    username: row.username,
    userId: row.user_id,
    homeserver: row.homeserver,
    accessToken: row.access_token,
    createdAt: row.created_at,
  };
  if (row.device_id) result.deviceId = row.device_id;
  if (row.last_used_at) result.lastUsedAt = row.last_used_at;
  return result;
}

/**
 * Add or update a Matrix account
 */
export function dbUpsertMatrixAccount(account: Omit<MatrixAccount, "createdAt" | "lastUsedAt">): MatrixAccount {
  const s = getStatements();
  const existing = s.getMatrixAccount.get(account.username) as MatrixAccountRow | undefined;
  const now = Date.now();

  s.upsertMatrixAccount.run(
    account.username,
    account.userId,
    account.homeserver,
    account.accessToken,
    account.deviceId ?? null,
    existing?.created_at ?? now,
    now,
  );

  log.info("Upserted matrix account", { username: account.username, userId: account.userId });
  return dbGetMatrixAccount(account.username)!;
}

/**
 * Get a Matrix account by username
 */
export function dbGetMatrixAccount(username: string): MatrixAccount | null {
  const s = getStatements();
  const row = s.getMatrixAccount.get(username) as MatrixAccountRow | undefined;
  return row ? rowToMatrixAccount(row) : null;
}

/**
 * List all Matrix accounts
 */
export function dbListMatrixAccounts(): MatrixAccount[] {
  const s = getStatements();
  const rows = s.listMatrixAccounts.all() as MatrixAccountRow[];
  return rows.map(rowToMatrixAccount);
}

/**
 * Delete a Matrix account
 */
export function dbDeleteMatrixAccount(username: string): boolean {
  // Check if any agent references this account
  const agents = dbListAgents();
  const referencingAgent = agents.find((a) => a.matrixAccount === username);
  if (referencingAgent) {
    throw new Error(`Cannot delete: account is used by agent "${referencingAgent.id}"`);
  }

  const s = getStatements();
  s.deleteMatrixAccount.run(username);
  if (getDbChanges() > 0) {
    log.info("Deleted matrix account", { username });
    return true;
  }
  return false;
}

/**
 * Touch a Matrix account (update last_used_at)
 */
export function dbTouchMatrixAccount(username: string): void {
  const s = getStatements();
  s.touchMatrixAccount.run(Date.now(), username);
}

/**
 * Get Matrix account for an agent
 */
export function dbGetAgentMatrixAccount(agentId: string): MatrixAccount | null {
  const agent = dbGetAgent(agentId);
  if (!agent?.matrixAccount) return null;
  return dbGetMatrixAccount(agent.matrixAccount);
}

// ============================================================================
// Message Metadata (transcriptions + media paths for reply reinjection)
// ============================================================================

export interface MessageMetadata {
  messageId: string;
  chatId: string;
  canonicalChatId?: string;
  actorType?: "contact" | "agent" | "system" | "unknown" | string;
  contactId?: string;
  agentId?: string;
  platformIdentityId?: string;
  rawSenderId?: string;
  normalizedSenderId?: string;
  identityConfidence?: number;
  identityProvenance?: Record<string, unknown>;
  transcription?: string;
  mediaPath?: string;
  mediaType?: string;
  createdAt: number;
}

/**
 * Store message metadata (transcription/media path).
 * Upserts — safe to call multiple times for the same message.
 */
export function dbSaveMessageMeta(
  messageId: string,
  chatId: string,
  opts: {
    canonicalChatId?: string;
    actorType?: string;
    contactId?: string;
    agentId?: string;
    platformIdentityId?: string;
    rawSenderId?: string;
    normalizedSenderId?: string;
    identityConfidence?: number;
    identityProvenance?: Record<string, unknown>;
    transcription?: string;
    mediaPath?: string;
    mediaType?: string;
  },
): void {
  const s = getStatements();
  s.upsertMessageMeta.run(
    messageId,
    chatId,
    opts.canonicalChatId ?? null,
    opts.actorType ?? null,
    opts.contactId ?? null,
    opts.agentId ?? null,
    opts.platformIdentityId ?? null,
    opts.rawSenderId ?? null,
    opts.normalizedSenderId ?? null,
    opts.identityConfidence ?? null,
    cleanJsonRecord(opts.identityProvenance),
    opts.transcription ?? null,
    opts.mediaPath ?? null,
    opts.mediaType ?? null,
    Date.now(),
  );
}

/**
 * Get message metadata by message ID.
 */
export function dbGetMessageMeta(messageId: string): MessageMetadata | null {
  const s = getStatements();
  const row = s.getMessageMeta.get(messageId) as {
    message_id: string;
    chat_id: string;
    canonical_chat_id: string | null;
    actor_type: string | null;
    contact_id: string | null;
    agent_id: string | null;
    platform_identity_id: string | null;
    raw_sender_id: string | null;
    normalized_sender_id: string | null;
    identity_confidence: number | null;
    identity_provenance_json: string | null;
    transcription: string | null;
    media_path: string | null;
    media_type: string | null;
    created_at: number;
  } | null;
  if (!row) return null;
  return {
    messageId: row.message_id,
    chatId: row.chat_id,
    canonicalChatId: row.canonical_chat_id ?? undefined,
    actorType: row.actor_type ?? undefined,
    contactId: row.contact_id ?? undefined,
    agentId: row.agent_id ?? undefined,
    platformIdentityId: row.platform_identity_id ?? undefined,
    rawSenderId: row.raw_sender_id ?? undefined,
    normalizedSenderId: row.normalized_sender_id ?? undefined,
    identityConfidence: row.identity_confidence ?? undefined,
    identityProvenance: parseJsonRecord(row.identity_provenance_json),
    transcription: row.transcription ?? undefined,
    mediaPath: row.media_path ?? undefined,
    mediaType: row.media_type ?? undefined,
    createdAt: row.created_at,
  };
}

export function dbListMessageMetaByChatId(chatId: string, limit = 50): MessageMetadata[] {
  const s = getStatements();
  const rows = s.listMessageMetaByChatId.all(chatId, limit) as Array<{
    message_id: string;
    chat_id: string;
    canonical_chat_id: string | null;
    actor_type: string | null;
    contact_id: string | null;
    agent_id: string | null;
    platform_identity_id: string | null;
    raw_sender_id: string | null;
    normalized_sender_id: string | null;
    identity_confidence: number | null;
    identity_provenance_json: string | null;
    transcription: string | null;
    media_path: string | null;
    media_type: string | null;
    created_at: number;
  }>;

  return rows.reverse().map((row) => ({
    messageId: row.message_id,
    chatId: row.chat_id,
    canonicalChatId: row.canonical_chat_id ?? undefined,
    actorType: row.actor_type ?? undefined,
    contactId: row.contact_id ?? undefined,
    agentId: row.agent_id ?? undefined,
    platformIdentityId: row.platform_identity_id ?? undefined,
    rawSenderId: row.raw_sender_id ?? undefined,
    normalizedSenderId: row.normalized_sender_id ?? undefined,
    identityConfidence: row.identity_confidence ?? undefined,
    identityProvenance: parseJsonRecord(row.identity_provenance_json),
    transcription: row.transcription ?? undefined,
    mediaPath: row.media_path ?? undefined,
    mediaType: row.media_type ?? undefined,
    createdAt: row.created_at,
  }));
}

const MESSAGE_META_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Delete message metadata older than 7 days.
 * Returns number of rows deleted.
 */
export function dbCleanupMessageMeta(): number {
  const s = getStatements();
  s.cleanupMessageMeta.run(Date.now() - MESSAGE_META_TTL_MS);
  return getDbChanges();
}

/**
 * Hard-delete ephemeral sessions that have already expired.
 * Safe to call at any time — idempotent, only removes rows with expires_at <= now.
 * Returns number of rows deleted.
 */
export function dbCleanupExpiredSessions(): number {
  const s = getStatements();
  s.cleanupExpiredSessions.run(Date.now());
  return getDbChanges();
}

// ============================================================================
// Audit Log
// ============================================================================

export interface AuditEntry {
  id: number;
  action: string;
  entity: string;
  entityId: string;
  oldValue: unknown | null;
  actor: string;
  ts: number;
}

// ============================================================================
// Cost Events
// ============================================================================

export interface CostEvent {
  id: number;
  sessionKey: string;
  agentId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  inputCostUsd: number;
  outputCostUsd: number;
  cacheCostUsd: number;
  totalCostUsd: number;
  createdAt: number;
}

/**
 * Insert a cost event for a single turn.
 */
export function dbInsertCostEvent(event: Omit<CostEvent, "id">): void {
  const s = getStatements();
  s.insertCostEvent.run(
    event.sessionKey,
    event.agentId,
    event.model,
    event.inputTokens,
    event.outputTokens,
    event.cacheReadTokens,
    event.cacheCreationTokens,
    event.inputCostUsd,
    event.outputCostUsd,
    event.cacheCostUsd,
    event.totalCostUsd,
    event.createdAt,
  );
}

interface CostSummaryRow {
  total_cost: number;
  total_input: number;
  total_output: number;
  total_cache_read: number;
  total_cache_creation: number;
  turns: number;
}

interface AgentCostRow extends CostSummaryRow {
  agent_id: string;
  model: string;
}

interface SessionCostRow extends CostSummaryRow {
  session_key: string;
}

/**
 * Get total cost summary for a time range.
 */
export function dbGetCostSummary(sinceMs: number): CostSummaryRow {
  const db = getDb();
  return db
    .prepare(
      `SELECT
        COALESCE(SUM(total_cost_usd), 0) as total_cost,
        COALESCE(SUM(input_tokens), 0) as total_input,
        COALESCE(SUM(output_tokens), 0) as total_output,
        COALESCE(SUM(cache_read_tokens), 0) as total_cache_read,
        COALESCE(SUM(cache_creation_tokens), 0) as total_cache_creation,
        COUNT(*) as turns
      FROM cost_events WHERE created_at >= ?`,
    )
    .get(sinceMs) as CostSummaryRow;
}

/**
 * Get cost breakdown by agent for a time range.
 */
export function dbGetCostByAgent(sinceMs: number): AgentCostRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT
      agent_id,
      model,
      COALESCE(SUM(total_cost_usd), 0) as total_cost,
      COALESCE(SUM(input_tokens), 0) as total_input,
      COALESCE(SUM(output_tokens), 0) as total_output,
      COALESCE(SUM(cache_read_tokens), 0) as total_cache_read,
      COALESCE(SUM(cache_creation_tokens), 0) as total_cache_creation,
      COUNT(*) as turns
    FROM cost_events WHERE created_at >= ?
    GROUP BY agent_id, model
    ORDER BY total_cost DESC`,
    )
    .all(sinceMs) as AgentCostRow[];
}

/**
 * Get cost for a specific agent in a time range.
 */
export function dbGetCostForAgent(agentId: string, sinceMs: number): CostSummaryRow {
  const db = getDb();
  return db
    .prepare(
      `SELECT
        COALESCE(SUM(total_cost_usd), 0) as total_cost,
        COALESCE(SUM(input_tokens), 0) as total_input,
        COALESCE(SUM(output_tokens), 0) as total_output,
        COALESCE(SUM(cache_read_tokens), 0) as total_cache_read,
        COALESCE(SUM(cache_creation_tokens), 0) as total_cache_creation,
        COUNT(*) as turns
      FROM cost_events WHERE agent_id = ? AND created_at >= ?`,
    )
    .get(agentId, sinceMs) as CostSummaryRow;
}

/**
 * Get cost for a specific session.
 */
export function dbGetCostForSession(sessionKey: string): CostSummaryRow {
  const db = getDb();
  return db
    .prepare(
      `SELECT
        COALESCE(SUM(total_cost_usd), 0) as total_cost,
        COALESCE(SUM(input_tokens), 0) as total_input,
        COALESCE(SUM(output_tokens), 0) as total_output,
        COALESCE(SUM(cache_read_tokens), 0) as total_cache_read,
        COALESCE(SUM(cache_creation_tokens), 0) as total_cache_creation,
        COUNT(*) as turns
      FROM cost_events WHERE session_key = ?`,
    )
    .get(sessionKey) as CostSummaryRow;
}

/**
 * Get top N most expensive sessions in a time range.
 */
export function dbGetTopSessions(sinceMs: number, limit = 10): SessionCostRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT
      session_key,
      COALESCE(SUM(total_cost_usd), 0) as total_cost,
      COALESCE(SUM(input_tokens), 0) as total_input,
      COALESCE(SUM(output_tokens), 0) as total_output,
      COALESCE(SUM(cache_read_tokens), 0) as total_cache_read,
      COALESCE(SUM(cache_creation_tokens), 0) as total_cache_creation,
      COUNT(*) as turns
    FROM cost_events WHERE created_at >= ?
    GROUP BY session_key
    ORDER BY total_cost DESC
    LIMIT ?`,
    )
    .all(sinceMs, limit) as SessionCostRow[];
}

/**
 * Get cost report for a date range (from, to in ms).
 */
export function dbGetCostReport(fromMs: number, toMs: number): AgentCostRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT
      agent_id,
      model,
      COALESCE(SUM(total_cost_usd), 0) as total_cost,
      COALESCE(SUM(input_tokens), 0) as total_input,
      COALESCE(SUM(output_tokens), 0) as total_output,
      COALESCE(SUM(cache_read_tokens), 0) as total_cache_read,
      COALESCE(SUM(cache_creation_tokens), 0) as total_cache_creation,
      COUNT(*) as turns
    FROM cost_events WHERE created_at >= ? AND created_at < ?
    GROUP BY agent_id, model
    ORDER BY total_cost DESC`,
    )
    .all(fromMs, toMs) as AgentCostRow[];
}

/**
 * Read recent audit log entries.
 * @param entity  Filter by entity type ("route" | "instance"). Omit for all.
 * @param limit   Max rows to return (default 100).
 */
export function dbListAuditLog(entity?: string, limit = 100): AuditEntry[] {
  const db = getDb();
  const rows = entity
    ? (db.prepare("SELECT * FROM audit_log WHERE entity = ? ORDER BY ts DESC LIMIT ?").all(entity, limit) as Array<{
        id: number;
        action: string;
        entity: string;
        entity_id: string;
        old_value: string | null;
        actor: string;
        ts: number;
      }>)
    : (db.prepare("SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?").all(limit) as Array<{
        id: number;
        action: string;
        entity: string;
        entity_id: string;
        old_value: string | null;
        actor: string;
        ts: number;
      }>);
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    entity: r.entity,
    entityId: r.entity_id,
    oldValue: r.old_value ? JSON.parse(r.old_value) : null,
    actor: r.actor,
    ts: r.ts,
  }));
}
