import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { getRaviStateDir } from "./utils/paths.js";
import {
  attachTagSlugsToAsset,
  canonicalAssetIdsForTag,
  canonicalTagSlugsForAsset,
  replaceMirroredTagSlugsForAsset,
} from "./tags/helpers.js";
import { detachTagFromSelector, searchTagBindingsForSelector } from "./tags/service.js";
import { buildSqlWhereClause, countRows, normalizeLimitOffsetPage, type ListPage } from "./utils/pagination.js";
import { nats } from "./nats.js";

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
const CONTACT_EVENT_SCOPE_TYPES = new Set(["global", "domain", "project", "chat", "session", "org", "agent", "task"]);
const CRM_ENTITY_TYPES = new Set(["contact", "account", "opportunity", "task", "activity", "segment", "playbook"]);
const CRM_EVENT_SCOPE_TYPES = new Set([
  "global",
  "domain",
  "project",
  "chat",
  "session",
  "agent",
  "task",
  "account",
  "opportunity",
  "org",
  "contact",
]);
const CRM_OWNER_TYPES = new Set(["user", "agent", "team", "system"]);
const CRM_CONTACT_LIFECYCLES = new Set([
  "unknown",
  "lead",
  "qualified",
  "active",
  "onboarding",
  "waiting",
  "at_risk",
  "dormant",
  "churned",
  "partner",
  "vendor",
  "internal",
]);
const CRM_RELATIONSHIP_HEALTHS = new Set(["unknown", "good", "neutral", "needs_attention", "at_risk"]);
const CRM_PRIORITIES = new Set(["low", "normal", "high", "urgent"]);
const CRM_OPPORTUNITY_STATUSES = new Set(["open", "won", "lost", "paused", "archived"]);
const CRM_TASK_STATUSES = new Set(["open", "scheduled", "waiting", "done", "canceled", "snoozed"]);
const CRM_FACT_STATUSES = new Set(["proposed", "confirmed", "rejected", "superseded"]);

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
  initializeCrmSchema(database);
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

function tableHasColumn(database: Database, table: string, column: string): boolean {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((entry) => entry.name === column);
}

function ensureTableColumn(database: Database, table: string, column: string, definition: string): void {
  if (!tableHasColumn(database, table, column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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

    CREATE TABLE IF NOT EXISTS contact_events (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      scope_type TEXT NOT NULL DEFAULT 'global'
        CHECK(scope_type IN ('global', 'domain', 'project', 'chat', 'session', 'org', 'agent', 'task')),
      scope_id TEXT,
      source TEXT,
      actor_type TEXT CHECK(actor_type IS NULL OR actor_type IN ('user', 'agent', 'system', 'contact', 'unknown')),
      actor_id TEXT,
      platform_identity_id TEXT,
      chat_id TEXT,
      session_key TEXT,
      message_id TEXT,
      task_id TEXT,
      artifact_id TEXT,
      confidence REAL,
      payload_json TEXT,
      evidence_json TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      effective_at TEXT,
      CHECK(scope_type = 'global' OR scope_id IS NOT NULL)
    );

    CREATE INDEX IF NOT EXISTS idx_contact_events_contact_created
      ON contact_events(contact_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_contact_events_scope_contact
      ON contact_events(scope_type, scope_id, contact_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_contact_events_type_contact
      ON contact_events(event_type, contact_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS contact_contexts (
      contact_id TEXT NOT NULL,
      scope_type TEXT NOT NULL DEFAULT 'global'
        CHECK(scope_type IN ('global', 'domain', 'project', 'chat', 'session', 'org', 'agent', 'task')),
      scope_id TEXT NOT NULL DEFAULT '',
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      source TEXT,
      confidence REAL,
      updated_by_type TEXT,
      updated_by_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (contact_id, scope_type, scope_id, key),
      CHECK(scope_type = 'global' OR scope_id <> '')
    );

    CREATE INDEX IF NOT EXISTS idx_contact_contexts_contact_scope
      ON contact_contexts(contact_id, scope_type, scope_id);

    CREATE TABLE IF NOT EXISTS contacts_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

function initializeCrmSchema(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS crm_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      entity_type TEXT NOT NULL CHECK(entity_type IN ('contact', 'account', 'opportunity', 'task', 'activity', 'segment', 'playbook')),
      entity_id TEXT NOT NULL,

      contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
      account_id TEXT REFERENCES crm_accounts(id) ON DELETE SET NULL,
      opportunity_id TEXT REFERENCES crm_opportunities(id) ON DELETE SET NULL,
      task_id TEXT REFERENCES crm_tasks(id) ON DELETE SET NULL,
      activity_id TEXT REFERENCES crm_activities(id) ON DELETE SET NULL,

      actor_type TEXT NOT NULL DEFAULT 'system',
      actor_id TEXT,
      scope_type TEXT NOT NULL DEFAULT 'global',
      scope_id TEXT,

      source TEXT NOT NULL,
      idempotency_key TEXT,
      confidence REAL NOT NULL DEFAULT 1.0 CHECK(confidence >= 0 AND confidence <= 1),
      payload_json TEXT NOT NULL,
      previous_payload_json TEXT,
      evidence_json TEXT,

      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK(scope_type = 'global' OR scope_id IS NOT NULL)
    );

    CREATE INDEX IF NOT EXISTS idx_crm_events_entity
      ON crm_events(entity_type, entity_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_crm_events_contact
      ON crm_events(contact_id, created_at DESC)
      WHERE contact_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_crm_events_account
      ON crm_events(account_id, created_at DESC)
      WHERE account_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_crm_events_opportunity
      ON crm_events(opportunity_id, created_at DESC)
      WHERE opportunity_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_crm_events_task
      ON crm_events(task_id, created_at DESC)
      WHERE task_id IS NOT NULL;

    DROP TRIGGER IF EXISTS trg_crm_events_no_update;
    CREATE TRIGGER trg_crm_events_no_update
      BEFORE UPDATE ON crm_events
      WHEN NOT (
        NEW.id IS OLD.id
        AND NEW.event_type IS OLD.event_type
        AND NEW.entity_type IS OLD.entity_type
        AND NEW.entity_id IS OLD.entity_id
        AND (NEW.contact_id IS OLD.contact_id OR (OLD.contact_id IS NOT NULL AND NEW.contact_id IS NULL))
        AND (NEW.account_id IS OLD.account_id OR (OLD.account_id IS NOT NULL AND NEW.account_id IS NULL))
        AND (NEW.opportunity_id IS OLD.opportunity_id OR (OLD.opportunity_id IS NOT NULL AND NEW.opportunity_id IS NULL))
        AND (NEW.task_id IS OLD.task_id OR (OLD.task_id IS NOT NULL AND NEW.task_id IS NULL))
        AND (NEW.activity_id IS OLD.activity_id OR (OLD.activity_id IS NOT NULL AND NEW.activity_id IS NULL))
        AND NEW.actor_type IS OLD.actor_type
        AND NEW.actor_id IS OLD.actor_id
        AND NEW.scope_type IS OLD.scope_type
        AND NEW.scope_id IS OLD.scope_id
        AND NEW.source IS OLD.source
        AND NEW.confidence IS OLD.confidence
        AND NEW.payload_json IS OLD.payload_json
        AND NEW.previous_payload_json IS OLD.previous_payload_json
        AND NEW.evidence_json IS OLD.evidence_json
        AND NEW.created_at IS OLD.created_at
        AND (
          (OLD.contact_id IS NOT NULL AND NEW.contact_id IS NULL)
          OR (OLD.account_id IS NOT NULL AND NEW.account_id IS NULL)
          OR (OLD.opportunity_id IS NOT NULL AND NEW.opportunity_id IS NULL)
          OR (OLD.task_id IS NOT NULL AND NEW.task_id IS NULL)
          OR (OLD.activity_id IS NOT NULL AND NEW.activity_id IS NULL)
        )
      )
      BEGIN
        SELECT RAISE(ABORT, 'crm_events is append-only');
      END;

    CREATE TRIGGER IF NOT EXISTS trg_crm_events_no_delete
      BEFORE DELETE ON crm_events
      BEGIN
        SELECT RAISE(ABORT, 'crm_events is append-only');
      END;

    CREATE TABLE IF NOT EXISTS crm_contact_profiles (
      contact_id TEXT PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,

      lifecycle TEXT NOT NULL DEFAULT 'unknown'
        CHECK(lifecycle IN ('unknown', 'lead', 'qualified', 'active', 'onboarding', 'waiting', 'at_risk', 'dormant', 'churned', 'partner', 'vendor', 'internal')),
      relationship_health TEXT NOT NULL DEFAULT 'unknown'
        CHECK(relationship_health IN ('unknown', 'good', 'neutral', 'needs_attention', 'at_risk')),
      priority TEXT NOT NULL DEFAULT 'normal'
        CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
      score REAL,
      health_score REAL,

      owner_type TEXT CHECK(owner_type IS NULL OR owner_type IN ('user', 'agent', 'team', 'system')),
      owner_id TEXT,

      primary_account_id TEXT REFERENCES crm_accounts(id) ON DELETE SET NULL,
      primary_opportunity_id TEXT REFERENCES crm_opportunities(id) ON DELETE SET NULL,

      lead_source TEXT,
      persona TEXT,
      buying_role TEXT,

      last_meaningful_interaction_at TEXT,
      next_action_at TEXT,
      next_action_summary TEXT,
      next_task_id TEXT REFERENCES crm_tasks(id) ON DELETE SET NULL,

      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK((owner_type IS NULL AND owner_id IS NULL) OR (owner_type IS NOT NULL AND owner_id IS NOT NULL))
    );

    CREATE INDEX IF NOT EXISTS idx_crm_contact_profiles_lifecycle
      ON crm_contact_profiles(lifecycle, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_crm_contact_profiles_owner
      ON crm_contact_profiles(owner_type, owner_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_crm_contact_profiles_next_action
      ON crm_contact_profiles(next_action_at)
      WHERE next_action_at IS NOT NULL;

    CREATE TABLE IF NOT EXISTS crm_accounts (
      id TEXT PRIMARY KEY,
      org_contact_id TEXT UNIQUE REFERENCES contacts(id) ON DELETE SET NULL,

      name TEXT NOT NULL,
      legal_name TEXT,
      domain TEXT,
      website_url TEXT,
      industry TEXT,
      size_label TEXT,
      lifecycle TEXT NOT NULL DEFAULT 'unknown'
        CHECK(lifecycle IN ('unknown', 'lead', 'qualified', 'active', 'onboarding', 'waiting', 'at_risk', 'dormant', 'churned', 'partner', 'vendor', 'internal')),
      relationship_health TEXT NOT NULL DEFAULT 'unknown'
        CHECK(relationship_health IN ('unknown', 'good', 'neutral', 'needs_attention', 'at_risk')),
      priority TEXT NOT NULL DEFAULT 'normal'
        CHECK(priority IN ('low', 'normal', 'high', 'urgent')),

      owner_type TEXT CHECK(owner_type IS NULL OR owner_type IN ('user', 'agent', 'team', 'system')),
      owner_id TEXT,

      source TEXT NOT NULL DEFAULT 'manual',
      idempotency_key TEXT,
      confidence REAL NOT NULL DEFAULT 1.0 CHECK(confidence >= 0 AND confidence <= 1),
      metadata_json TEXT NOT NULL DEFAULT '{}',

      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      archived_at TEXT,
      CHECK((owner_type IS NULL AND owner_id IS NULL) OR (owner_type IS NOT NULL AND owner_id IS NOT NULL))
    );

    CREATE INDEX IF NOT EXISTS idx_crm_accounts_name
      ON crm_accounts(name);
    CREATE INDEX IF NOT EXISTS idx_crm_accounts_domain
      ON crm_accounts(domain)
      WHERE domain IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_crm_accounts_owner
      ON crm_accounts(owner_type, owner_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS crm_account_contacts (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES crm_accounts(id) ON DELETE CASCADE,
      contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,

      role TEXT NOT NULL DEFAULT 'member',
      title TEXT,
      department TEXT,
      decision_role TEXT NOT NULL DEFAULT 'unknown',
      relationship_strength TEXT NOT NULL DEFAULT 'unknown',
      is_primary INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0, 1)),
      status TEXT NOT NULL DEFAULT 'active',

      source TEXT NOT NULL DEFAULT 'manual',
      idempotency_key TEXT,
      confidence REAL NOT NULL DEFAULT 1.0 CHECK(confidence >= 0 AND confidence <= 1),
      evidence_json TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',

      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),

      UNIQUE(account_id, contact_id, role)
    );

    CREATE INDEX IF NOT EXISTS idx_crm_account_contacts_contact
      ON crm_account_contacts(contact_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_crm_account_contacts_account
      ON crm_account_contacts(account_id, is_primary DESC, updated_at DESC);

    CREATE TABLE IF NOT EXISTS crm_pipelines (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      entity_type TEXT NOT NULL DEFAULT 'opportunity',
      is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0, 1)),
      status TEXT NOT NULL DEFAULT 'active',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_pipelines_default
      ON crm_pipelines(entity_type, is_default)
      WHERE is_default = 1;

    CREATE TABLE IF NOT EXISTS crm_pipeline_stages (
      id TEXT PRIMARY KEY,
      pipeline_id TEXT NOT NULL REFERENCES crm_pipelines(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      category TEXT NOT NULL DEFAULT 'active',
      probability REAL,
      is_terminal INTEGER NOT NULL DEFAULT 0 CHECK(is_terminal IN (0, 1)),
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),

      UNIQUE(pipeline_id, key),
      UNIQUE(pipeline_id, sort_order)
    );

    CREATE INDEX IF NOT EXISTS idx_crm_pipeline_stages_pipeline
      ON crm_pipeline_stages(pipeline_id, sort_order);

    CREATE TABLE IF NOT EXISTS crm_opportunities (
      id TEXT PRIMARY KEY,
      account_id TEXT REFERENCES crm_accounts(id) ON DELETE SET NULL,
      primary_contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,

      pipeline_id TEXT REFERENCES crm_pipelines(id) ON DELETE SET NULL,
      stage_id TEXT REFERENCES crm_pipeline_stages(id) ON DELETE SET NULL,

      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'open'
        CHECK(status IN ('open', 'won', 'lost', 'paused', 'archived')),
      priority TEXT NOT NULL DEFAULT 'normal'
        CHECK(priority IN ('low', 'normal', 'high', 'urgent')),

      value_cents INTEGER,
      currency TEXT NOT NULL DEFAULT 'BRL',
      probability REAL,
      expected_close_at TEXT,
      closed_at TEXT,
      lost_reason TEXT,

      owner_type TEXT CHECK(owner_type IS NULL OR owner_type IN ('user', 'agent', 'team', 'system')),
      owner_id TEXT,

      source TEXT NOT NULL DEFAULT 'manual',
      idempotency_key TEXT,
      confidence REAL NOT NULL DEFAULT 1.0 CHECK(confidence >= 0 AND confidence <= 1),
      evidence_json TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',

      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      archived_at TEXT,
      CHECK((owner_type IS NULL AND owner_id IS NULL) OR (owner_type IS NOT NULL AND owner_id IS NOT NULL))
    );

    CREATE INDEX IF NOT EXISTS idx_crm_opportunities_account
      ON crm_opportunities(account_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_crm_opportunities_contact
      ON crm_opportunities(primary_contact_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_crm_opportunities_stage
      ON crm_opportunities(pipeline_id, stage_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_crm_opportunities_owner
      ON crm_opportunities(owner_type, owner_id, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS crm_opportunity_contacts (
      id TEXT PRIMARY KEY,
      opportunity_id TEXT NOT NULL REFERENCES crm_opportunities(id) ON DELETE CASCADE,
      contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      account_id TEXT REFERENCES crm_accounts(id) ON DELETE SET NULL,

      role TEXT NOT NULL DEFAULT 'stakeholder',
      influence TEXT NOT NULL DEFAULT 'unknown',
      sentiment TEXT NOT NULL DEFAULT 'unknown',
      is_primary INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0, 1)),

      source TEXT NOT NULL DEFAULT 'manual',
      confidence REAL NOT NULL DEFAULT 1.0 CHECK(confidence >= 0 AND confidence <= 1),
      evidence_json TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',

      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),

      UNIQUE(opportunity_id, contact_id, role)
    );

    CREATE INDEX IF NOT EXISTS idx_crm_opportunity_contacts_contact
      ON crm_opportunity_contacts(contact_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_crm_opportunity_contacts_opportunity
      ON crm_opportunity_contacts(opportunity_id, is_primary DESC, updated_at DESC);

    CREATE TABLE IF NOT EXISTS crm_tasks (
      id TEXT PRIMARY KEY,

      contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
      account_id TEXT REFERENCES crm_accounts(id) ON DELETE SET NULL,
      opportunity_id TEXT REFERENCES crm_opportunities(id) ON DELETE SET NULL,
      chat_id TEXT,
      session_key TEXT,

      title TEXT NOT NULL,
      body TEXT,
      task_type TEXT NOT NULL DEFAULT 'follow_up',
      status TEXT NOT NULL DEFAULT 'open'
        CHECK(status IN ('open', 'scheduled', 'waiting', 'done', 'canceled', 'snoozed')),
      priority TEXT NOT NULL DEFAULT 'normal'
        CHECK(priority IN ('low', 'normal', 'high', 'urgent')),

      due_at TEXT,
      snoozed_until TEXT,
      completed_at TEXT,
      canceled_at TEXT,

      owner_type TEXT CHECK(owner_type IS NULL OR owner_type IN ('user', 'agent', 'team', 'system')),
      owner_id TEXT,
      created_by_type TEXT NOT NULL DEFAULT 'system',
      created_by_id TEXT,

      source TEXT NOT NULL DEFAULT 'manual',
      confidence REAL NOT NULL DEFAULT 1.0 CHECK(confidence >= 0 AND confidence <= 1),
      evidence_json TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',

      ravi_task_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK((owner_type IS NULL AND owner_id IS NULL) OR (owner_type IS NOT NULL AND owner_id IS NOT NULL))
    );

    CREATE INDEX IF NOT EXISTS idx_crm_tasks_due
      ON crm_tasks(status, due_at)
      WHERE status IN ('open', 'scheduled', 'waiting', 'snoozed');
    CREATE INDEX IF NOT EXISTS idx_crm_tasks_contact
      ON crm_tasks(contact_id, status, due_at)
      WHERE contact_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_crm_tasks_account
      ON crm_tasks(account_id, status, due_at)
      WHERE account_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_crm_tasks_opportunity
      ON crm_tasks(opportunity_id, status, due_at)
      WHERE opportunity_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_crm_tasks_owner
      ON crm_tasks(owner_type, owner_id, status, due_at);

    CREATE TABLE IF NOT EXISTS crm_activities (
      id TEXT PRIMARY KEY,

      activity_type TEXT NOT NULL,
      title TEXT,
      summary TEXT NOT NULL,
      body TEXT,
      occurred_at TEXT NOT NULL,

      contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
      account_id TEXT REFERENCES crm_accounts(id) ON DELETE SET NULL,
      opportunity_id TEXT REFERENCES crm_opportunities(id) ON DELETE SET NULL,
      task_id TEXT REFERENCES crm_tasks(id) ON DELETE SET NULL,

      chat_id TEXT,
      session_key TEXT,
      message_id TEXT,
      contact_event_id TEXT REFERENCES contact_events(id) ON DELETE SET NULL,
      session_event_id TEXT,

      actor_type TEXT NOT NULL DEFAULT 'system',
      actor_id TEXT,

      source TEXT NOT NULL,
      idempotency_key TEXT,
      confidence REAL NOT NULL DEFAULT 1.0 CHECK(confidence >= 0 AND confidence <= 1),
      evidence_json TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',

      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_crm_activities_contact
      ON crm_activities(contact_id, occurred_at DESC)
      WHERE contact_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_crm_activities_account
      ON crm_activities(account_id, occurred_at DESC)
      WHERE account_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_crm_activities_opportunity
      ON crm_activities(opportunity_id, occurred_at DESC)
      WHERE opportunity_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_crm_activities_message
      ON crm_activities(message_id)
      WHERE message_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_activities_contact_event_unique
      ON crm_activities(contact_event_id)
      WHERE contact_event_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS crm_activity_participants (
      id TEXT PRIMARY KEY,
      activity_id TEXT NOT NULL REFERENCES crm_activities(id) ON DELETE CASCADE,
      contact_id TEXT REFERENCES contacts(id) ON DELETE CASCADE,
      account_id TEXT REFERENCES crm_accounts(id) ON DELETE SET NULL,
      role TEXT NOT NULL DEFAULT 'participant',
      actor_type TEXT,
      actor_id TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      confidence REAL NOT NULL DEFAULT 1.0 CHECK(confidence >= 0 AND confidence <= 1),
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK(contact_id IS NOT NULL OR account_id IS NOT NULL),
      UNIQUE(activity_id, contact_id, account_id, role)
    );

    CREATE INDEX IF NOT EXISTS idx_crm_activity_participants_activity
      ON crm_activity_participants(activity_id);
    CREATE INDEX IF NOT EXISTS idx_crm_activity_participants_contact
      ON crm_activity_participants(contact_id)
      WHERE contact_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS crm_facts (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL CHECK(entity_type IN ('contact', 'account', 'opportunity', 'task', 'activity', 'segment', 'playbook')),
      entity_id TEXT NOT NULL,
      contact_id TEXT REFERENCES contacts(id) ON DELETE CASCADE,
      account_id TEXT REFERENCES crm_accounts(id) ON DELETE CASCADE,
      opportunity_id TEXT REFERENCES crm_opportunities(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'proposed'
        CHECK(status IN ('proposed', 'confirmed', 'rejected', 'superseded')),
      source TEXT NOT NULL DEFAULT 'manual',
      idempotency_key TEXT,
      confidence REAL NOT NULL DEFAULT 1.0 CHECK(confidence >= 0 AND confidence <= 1),
      evidence_json TEXT,
      scope_type TEXT NOT NULL DEFAULT 'global',
      scope_id TEXT,
      proposed_by_type TEXT,
      proposed_by_id TEXT,
      confirmed_by_type TEXT,
      confirmed_by_id TEXT,
      supersedes_fact_id TEXT REFERENCES crm_facts(id) ON DELETE SET NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK(scope_type = 'global' OR scope_id IS NOT NULL)
    );

    CREATE INDEX IF NOT EXISTS idx_crm_facts_entity_key
      ON crm_facts(entity_type, entity_id, key, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_crm_facts_contact_key
      ON crm_facts(contact_id, key, status, updated_at DESC)
      WHERE contact_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_crm_facts_scope
      ON crm_facts(scope_type, scope_id, key, status, updated_at DESC);

    DROP VIEW IF EXISTS crm_account_cards;

    CREATE VIEW IF NOT EXISTS crm_contact_cards AS
    SELECT
      c.id AS contact_id,
      c.display_name,
      c.kind,
      cp.status AS policy_status,
      cp.reply_mode,
      cp.tags_json,
      p.lifecycle,
      p.relationship_health,
      p.priority,
      p.owner_type,
      p.owner_id,
      p.primary_account_id,
      p.primary_opportunity_id,
      p.last_meaningful_interaction_at,
      p.next_action_at,
      p.next_action_summary,
      p.next_task_id,
      c.updated_at
    FROM contacts c
    LEFT JOIN contact_policies cp ON cp.contact_id = c.id
    LEFT JOIN crm_contact_profiles p ON p.contact_id = c.id;

    CREATE VIEW IF NOT EXISTS crm_next_actions AS
    SELECT
      t.id AS task_id,
      t.title,
      t.task_type,
      t.status,
      t.priority,
      t.due_at,
      t.contact_id,
      c.display_name AS contact_name,
      t.account_id,
      a.name AS account_name,
      t.opportunity_id,
      o.title AS opportunity_title,
      t.owner_type,
      t.owner_id
    FROM crm_tasks t
    LEFT JOIN contacts c ON c.id = t.contact_id
    LEFT JOIN crm_accounts a ON a.id = t.account_id
    LEFT JOIN crm_opportunities o ON o.id = t.opportunity_id
    WHERE t.status IN ('open', 'scheduled', 'waiting', 'snoozed')
    ORDER BY
      CASE t.priority
        WHEN 'urgent' THEN 0
        WHEN 'high' THEN 1
        WHEN 'normal' THEN 2
        ELSE 3
      END,
      t.due_at ASC;

    CREATE VIEW IF NOT EXISTS crm_opportunity_board AS
    SELECT
      o.id AS opportunity_id,
      o.title,
      o.status,
      o.priority,
      o.value_cents,
      o.currency,
      o.probability,
      o.expected_close_at,
      o.pipeline_id,
      ps.key AS stage_key,
      ps.name AS stage_name,
      ps.sort_order AS stage_order,
      o.account_id,
      a.name AS account_name,
      o.primary_contact_id,
      c.display_name AS primary_contact_name,
      o.owner_type,
      o.owner_id,
      o.updated_at
    FROM crm_opportunities o
    LEFT JOIN crm_pipeline_stages ps ON ps.id = o.stage_id
    LEFT JOIN crm_accounts a ON a.id = o.account_id
    LEFT JOIN contacts c ON c.id = o.primary_contact_id
    WHERE o.status = 'open'
    ORDER BY ps.sort_order ASC, o.updated_at DESC;

    CREATE VIEW IF NOT EXISTS crm_account_cards AS
    SELECT
      a.id AS account_id,
      a.org_contact_id,
      a.name,
      a.domain,
      a.lifecycle,
      a.relationship_health,
      a.priority,
      a.owner_type,
      a.owner_id,
      COALESCE(ac.contact_count, 0) AS contact_count,
      COALESCE(oo.open_opportunity_count, 0) AS open_opportunity_count,
      COALESCE(oo.open_value_cents, 0) AS open_value_cents,
      a.updated_at
    FROM crm_accounts a
    LEFT JOIN (
      SELECT account_id, COUNT(DISTINCT contact_id) AS contact_count
      FROM crm_account_contacts
      GROUP BY account_id
    ) ac ON ac.account_id = a.id
    LEFT JOIN (
      SELECT account_id, COUNT(*) AS open_opportunity_count, SUM(COALESCE(value_cents, 0)) AS open_value_cents
      FROM crm_opportunities
      WHERE status = 'open' AND archived_at IS NULL
      GROUP BY account_id
    ) oo ON oo.account_id = a.id;
  `);

  ensureTableColumn(database, "crm_events", "idempotency_key", "TEXT");
  ensureTableColumn(database, "crm_accounts", "idempotency_key", "TEXT");
  ensureTableColumn(database, "crm_opportunities", "idempotency_key", "TEXT");
  ensureTableColumn(database, "crm_tasks", "idempotency_key", "TEXT");
  ensureTableColumn(database, "crm_activities", "idempotency_key", "TEXT");
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_events_idempotency_key
      ON crm_events(idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_accounts_idempotency_key
      ON crm_accounts(idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_opportunities_idempotency_key
      ON crm_opportunities(idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_tasks_idempotency_key
      ON crm_tasks(idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_activities_idempotency_key
      ON crm_activities(idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_facts_idempotency_key
      ON crm_facts(idempotency_key)
      WHERE idempotency_key IS NOT NULL;

    DROP TRIGGER IF EXISTS trg_crm_events_no_update;
    CREATE TRIGGER trg_crm_events_no_update
      BEFORE UPDATE ON crm_events
      WHEN NOT (
        NEW.id IS OLD.id
        AND NEW.event_type IS OLD.event_type
        AND NEW.entity_type IS OLD.entity_type
        AND NEW.entity_id IS OLD.entity_id
        AND (NEW.contact_id IS OLD.contact_id OR (OLD.contact_id IS NOT NULL AND NEW.contact_id IS NULL))
        AND (NEW.account_id IS OLD.account_id OR (OLD.account_id IS NOT NULL AND NEW.account_id IS NULL))
        AND (NEW.opportunity_id IS OLD.opportunity_id OR (OLD.opportunity_id IS NOT NULL AND NEW.opportunity_id IS NULL))
        AND (NEW.task_id IS OLD.task_id OR (OLD.task_id IS NOT NULL AND NEW.task_id IS NULL))
        AND (NEW.activity_id IS OLD.activity_id OR (OLD.activity_id IS NOT NULL AND NEW.activity_id IS NULL))
        AND NEW.actor_type IS OLD.actor_type
        AND NEW.actor_id IS OLD.actor_id
        AND NEW.scope_type IS OLD.scope_type
        AND NEW.scope_id IS OLD.scope_id
        AND NEW.source IS OLD.source
        AND NEW.idempotency_key IS OLD.idempotency_key
        AND NEW.confidence IS OLD.confidence
        AND NEW.payload_json IS OLD.payload_json
        AND NEW.previous_payload_json IS OLD.previous_payload_json
        AND NEW.evidence_json IS OLD.evidence_json
        AND NEW.created_at IS OLD.created_at
        AND (
          (OLD.contact_id IS NOT NULL AND NEW.contact_id IS NULL)
          OR (OLD.account_id IS NOT NULL AND NEW.account_id IS NULL)
          OR (OLD.opportunity_id IS NOT NULL AND NEW.opportunity_id IS NULL)
          OR (OLD.task_id IS NOT NULL AND NEW.task_id IS NULL)
          OR (OLD.activity_id IS NOT NULL AND NEW.activity_id IS NULL)
        )
      )
      BEGIN
        SELECT RAISE(ABORT, 'crm_events is append-only');
      END;
  `);

  database
    .prepare(
      `
      INSERT INTO crm_pipelines (id, name, entity_type, is_default, status, metadata_json)
      VALUES ('crm_pipeline_default', 'Default Sales Pipeline', 'opportunity', 1, 'active', ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        entity_type = excluded.entity_type,
        is_default = excluded.is_default,
        status = excluded.status,
        updated_at = datetime('now')
    `,
    )
    .run(metadataJson({ source: "crm_schema_seed" }));

  const defaultStages = [
    { key: "new", name: "New", sortOrder: 10, category: "new", probability: 0.1, terminal: 0 },
    { key: "qualified", name: "Qualified", sortOrder: 20, category: "active", probability: 0.35, terminal: 0 },
    { key: "proposal", name: "Proposal", sortOrder: 30, category: "active", probability: 0.6, terminal: 0 },
    { key: "negotiation", name: "Negotiation", sortOrder: 40, category: "waiting", probability: 0.8, terminal: 0 },
    { key: "won", name: "Won", sortOrder: 90, category: "terminal_won", probability: 1, terminal: 1 },
    { key: "lost", name: "Lost", sortOrder: 100, category: "terminal_lost", probability: 0, terminal: 1 },
  ];
  const insertStage = database.prepare(`
    INSERT INTO crm_pipeline_stages (
      id, pipeline_id, key, name, sort_order, category, probability, is_terminal, metadata_json
    )
    VALUES (?, 'crm_pipeline_default', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(pipeline_id, key) DO UPDATE SET
      name = excluded.name,
      sort_order = excluded.sort_order,
      category = excluded.category,
      probability = excluded.probability,
      is_terminal = excluded.is_terminal,
      updated_at = datetime('now')
  `);
  for (const stage of defaultStages) {
    insertStage.run(
      `crm_stage_${stage.key}`,
      stage.key,
      stage.name,
      stage.sortOrder,
      stage.category,
      stage.probability,
      stage.terminal,
      metadataJson({ source: "crm_schema_seed" }),
    );
  }
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

function normalizeCanonicalTagSlug(value: string): string | null {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || null;
}

function legacyContactTagsFromJson(value: string | null): string[] {
  return (parseJsonArray(value)?.filter((tag): tag is string => typeof tag === "string" && tag.trim() !== "") ??
    []) as string[];
}

function getCanonicalContactTagSlugs(contactId: string): string[] {
  return canonicalTagSlugsForAsset("contact", contactId);
}

function mergeTagLists(...lists: string[][]): string[] {
  return [...new Set(lists.flat().filter((tag) => tag.trim() !== ""))];
}

function attachCanonicalContactTag(contactId: string, tag: string, source: string): string | null {
  const slug = normalizeCanonicalTagSlug(tag);
  if (!slug) return null;
  const [binding] = attachTagSlugsToAsset({
    assetType: "contact",
    assetId: contactId,
    tags: [slug],
    source,
    createdBy: "contacts",
    definitionMetadata: {
      source: "contacts",
      migration: "legacy-contact-tags",
      originalTag: tag,
    },
    metadata: {
      mirroredFrom: "contacts_v2.tags",
      originalTag: tag,
    },
  });
  return binding?.tagSlug ?? slug;
}

function syncCanonicalContactTags(contactId: string, tags: string[]): void {
  const slugs = tags.map((tag) => normalizeCanonicalTagSlug(tag)).filter((tag): tag is string => tag !== null);
  replaceMirroredTagSlugsForAsset({
    assetType: "contact",
    assetId: contactId,
    tags: slugs,
    source: "contacts_v2.tags",
    createdBy: "contacts",
    definitionMetadata: {
      source: "contacts",
      migration: "legacy-contact-tags",
    },
    metadata: {
      mirroredFrom: "contacts_v2.tags",
    },
  });
}

function deleteCanonicalContactTagBindings(contactId: string): void {
  for (const binding of searchTagBindingsForSelector({ selector: { target: `contact:${contactId}` } }).bindings) {
    detachTagFromSelector({
      slug: binding.tagSlug,
      selector: { target: `contact:${contactId}` },
      source: binding.source,
      actor: "contacts",
    });
  }
}

function moveCanonicalContactTagBindings(sourceContactId: string, targetContactId: string): void {
  for (const binding of searchTagBindingsForSelector({ selector: { target: `contact:${sourceContactId}` } }).bindings) {
    attachTagSlugsToAsset({
      assetType: "contact",
      assetId: targetContactId,
      tags: [binding.tagSlug],
      source: binding.source,
      createdBy: binding.createdBy ?? "contacts",
      metadata: {
        ...(binding.metadata ?? {}),
        source: binding.metadata?.source ?? "contact_merge",
        mergedFromContactId: sourceContactId,
      },
    });
    detachTagFromSelector({
      slug: binding.tagSlug,
      selector: { target: `contact:${sourceContactId}` },
      source: "contact_merge",
      actor: "contacts",
    });
  }
}

function contactTags(contactId: string, legacyTagsJson: string | null): string[] {
  const legacySlugs = legacyContactTagsFromJson(legacyTagsJson)
    .map((tag) => normalizeCanonicalTagSlug(tag))
    .filter((tag): tag is string => tag !== null);
  return mergeTagLists(legacySlugs, getCanonicalContactTagSlugs(contactId));
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
  database.prepare("DELETE FROM contact_contexts WHERE contact_id = ?").run(contactId);
  database.prepare("DELETE FROM contacts WHERE id = ?").run(contactId);
  deleteCanonicalContactTagBindings(contactId);
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
  const legacyContactTags = legacyContactTagsFromJson(row.tags);
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

  syncCanonicalContactTags(row.id, legacyContactTags);

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
export type ContactEventScopeType = "global" | "domain" | "project" | "chat" | "session" | "org" | "agent" | "task";
export type ContactEventActorType = "user" | "agent" | "system" | "contact" | "unknown";
export type CrmEntityType = "contact" | "account" | "opportunity" | "task" | "activity" | "segment" | "playbook";
export type CrmActorType = "user" | "agent" | "team" | "system" | "contact" | "unknown";
export type CrmOwnerType = "user" | "agent" | "team" | "system";
export type CrmContactLifecycle =
  | "unknown"
  | "lead"
  | "qualified"
  | "active"
  | "onboarding"
  | "waiting"
  | "at_risk"
  | "dormant"
  | "churned"
  | "partner"
  | "vendor"
  | "internal";
export type CrmRelationshipHealth = "unknown" | "good" | "neutral" | "needs_attention" | "at_risk";
export type CrmPriority = "low" | "normal" | "high" | "urgent";
export type CrmOpportunityStatus = "open" | "won" | "lost" | "paused" | "archived";
export type CrmTaskStatus = "open" | "scheduled" | "waiting" | "done" | "canceled" | "snoozed";
export type CrmScopeType =
  | "global"
  | "domain"
  | "project"
  | "chat"
  | "session"
  | "agent"
  | "task"
  | "account"
  | "opportunity"
  | "org"
  | "contact";

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

export interface ContactEventRefs {
  platformIdentityId?: string | null;
  chatId?: string | null;
  sessionKey?: string | null;
  messageId?: string | null;
  taskId?: string | null;
  artifactId?: string | null;
}

export interface CreateContactEventInput extends ContactEventRefs {
  contactRef: string;
  eventType: string;
  scopeType?: ContactEventScopeType | string | null;
  scopeId?: string | null;
  source?: string | null;
  actorType?: ContactEventActorType | null;
  actorId?: string | null;
  confidence?: number | null;
  payload?: unknown;
  evidence?: unknown;
  effectiveAt?: string | null;
}

export interface ContactEvent {
  id: string;
  contactId: string;
  eventType: string;
  scopeType: ContactEventScopeType;
  scopeId: string | null;
  source: string | null;
  actorType: ContactEventActorType | null;
  actorId: string | null;
  platformIdentityId: string | null;
  chatId: string | null;
  sessionKey: string | null;
  messageId: string | null;
  taskId: string | null;
  artifactId: string | null;
  confidence: number | null;
  payload: unknown;
  evidence: unknown;
  createdAt: string;
  effectiveAt: string | null;
}

export interface ListContactEventsOptions {
  limit?: number | string | null;
  offset?: number | string | null;
  scopeType?: ContactEventScopeType | string | null;
  scopeId?: string | null;
  eventType?: string | null;
}

export interface ContactEventsPage extends ListPage<ContactEvent> {
  contactId: string;
}

export interface CreateCrmEventInput {
  eventType: string;
  entityType: CrmEntityType | string;
  entityId: string;
  contactId?: string | null;
  accountId?: string | null;
  opportunityId?: string | null;
  taskId?: string | null;
  activityId?: string | null;
  actorType?: CrmActorType | string | null;
  actorId?: string | null;
  scopeType?: CrmScopeType | string | null;
  scopeId?: string | null;
  source: string;
  idempotencyKey?: string | null;
  confidence?: number | null;
  payload?: unknown;
  previousPayload?: unknown;
  evidence?: unknown;
  contactEventType?: string | null;
  emitContactEvent?: boolean;
}

export interface CrmEvent {
  id: string;
  eventType: string;
  entityType: CrmEntityType;
  entityId: string;
  contactId: string | null;
  accountId: string | null;
  opportunityId: string | null;
  taskId: string | null;
  activityId: string | null;
  actorType: string;
  actorId: string | null;
  scopeType: CrmScopeType;
  scopeId: string | null;
  source: string;
  idempotencyKey: string | null;
  confidence: number;
  payload: unknown;
  previousPayload: unknown;
  evidence: unknown;
  createdAt: string;
}

export interface CrmMutationOptions {
  source?: string | null;
  actorType?: CrmActorType | string | null;
  actorId?: string | null;
  confidence?: number | null;
  evidence?: unknown;
  scopeType?: CrmScopeType | string | null;
  scopeId?: string | null;
  idempotencyKey?: string | null;
}

export interface CrmContactProfile {
  contactId: string;
  lifecycle: CrmContactLifecycle;
  relationshipHealth: CrmRelationshipHealth;
  priority: CrmPriority;
  score: number | null;
  healthScore: number | null;
  ownerType: CrmOwnerType | null;
  ownerId: string | null;
  primaryAccountId: string | null;
  primaryOpportunityId: string | null;
  leadSource: string | null;
  persona: string | null;
  buyingRole: string | null;
  lastMeaningfulInteractionAt: string | null;
  nextActionAt: string | null;
  nextActionSummary: string | null;
  nextTaskId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateCrmContactProfileInput extends CrmMutationOptions {
  contactRef: string;
  lifecycle?: CrmContactLifecycle | string | null;
  relationshipHealth?: CrmRelationshipHealth | string | null;
  priority?: CrmPriority | string | null;
  score?: number | null;
  healthScore?: number | null;
  ownerType?: CrmOwnerType | string | null;
  ownerId?: string | null;
  primaryAccountId?: string | null;
  primaryOpportunityId?: string | null;
  leadSource?: string | null;
  persona?: string | null;
  buyingRole?: string | null;
  lastMeaningfulInteractionAt?: string | null;
  nextActionAt?: string | null;
  nextActionSummary?: string | null;
  nextTaskId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface CrmAccount {
  id: string;
  orgContactId: string | null;
  name: string;
  legalName: string | null;
  domain: string | null;
  websiteUrl: string | null;
  industry: string | null;
  sizeLabel: string | null;
  lifecycle: CrmContactLifecycle;
  relationshipHealth: CrmRelationshipHealth;
  priority: CrmPriority;
  ownerType: CrmOwnerType | null;
  ownerId: string | null;
  source: string;
  idempotencyKey: string | null;
  confidence: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface CreateCrmAccountInput extends CrmMutationOptions {
  name: string;
  orgContactRef?: string | null;
  legalName?: string | null;
  domain?: string | null;
  websiteUrl?: string | null;
  industry?: string | null;
  sizeLabel?: string | null;
  lifecycle?: CrmContactLifecycle | string | null;
  relationshipHealth?: CrmRelationshipHealth | string | null;
  priority?: CrmPriority | string | null;
  ownerType?: CrmOwnerType | string | null;
  ownerId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface CrmAccountContact {
  id: string;
  accountId: string;
  contactId: string;
  role: string;
  title: string | null;
  department: string | null;
  decisionRole: string;
  relationshipStrength: string;
  isPrimary: boolean;
  status: string;
  source: string;
  confidence: number;
  evidence: unknown;
  metadata: Record<string, unknown>;
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface LinkCrmAccountContactInput extends CrmMutationOptions {
  accountId: string;
  contactRef: string;
  role?: string | null;
  title?: string | null;
  department?: string | null;
  decisionRole?: string | null;
  relationshipStrength?: string | null;
  isPrimary?: boolean | null;
  status?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface CrmPipelineStage {
  id: string;
  pipelineId: string;
  key: string;
  name: string;
  sortOrder: number;
  category: string;
  probability: number | null;
  isTerminal: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CrmOpportunity {
  id: string;
  accountId: string | null;
  primaryContactId: string | null;
  pipelineId: string | null;
  stageId: string | null;
  title: string;
  description: string | null;
  status: CrmOpportunityStatus;
  priority: CrmPriority;
  valueCents: number | null;
  currency: string;
  probability: number | null;
  expectedCloseAt: string | null;
  closedAt: string | null;
  lostReason: string | null;
  ownerType: CrmOwnerType | null;
  ownerId: string | null;
  source: string;
  idempotencyKey: string | null;
  confidence: number;
  evidence: unknown;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface CreateCrmOpportunityInput extends CrmMutationOptions {
  title: string;
  accountId?: string | null;
  contactRef?: string | null;
  pipelineId?: string | null;
  stageId?: string | null;
  stageKey?: string | null;
  description?: string | null;
  status?: CrmOpportunityStatus | string | null;
  priority?: CrmPriority | string | null;
  valueCents?: number | null;
  currency?: string | null;
  probability?: number | null;
  expectedCloseAt?: string | null;
  ownerType?: CrmOwnerType | string | null;
  ownerId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface CrmOpportunityContact {
  id: string;
  opportunityId: string;
  contactId: string;
  accountId: string | null;
  role: string;
  influence: string;
  sentiment: string;
  isPrimary: boolean;
  source: string;
  confidence: number;
  evidence: unknown;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface LinkCrmOpportunityContactInput extends CrmMutationOptions {
  opportunityId: string;
  contactRef: string;
  accountId?: string | null;
  role?: string | null;
  influence?: string | null;
  sentiment?: string | null;
  isPrimary?: boolean | null;
  metadata?: Record<string, unknown> | null;
}

export interface MoveCrmOpportunityStageInput extends CrmMutationOptions {
  opportunityId: string;
  stageRef: string;
  lostReason?: string | null;
}

export interface CrmTask {
  id: string;
  contactId: string | null;
  accountId: string | null;
  opportunityId: string | null;
  chatId: string | null;
  sessionKey: string | null;
  title: string;
  body: string | null;
  taskType: string;
  status: CrmTaskStatus;
  priority: CrmPriority;
  dueAt: string | null;
  snoozedUntil: string | null;
  completedAt: string | null;
  canceledAt: string | null;
  ownerType: CrmOwnerType | null;
  ownerId: string | null;
  createdByType: string;
  createdById: string | null;
  source: string;
  idempotencyKey: string | null;
  confidence: number;
  evidence: unknown;
  metadata: Record<string, unknown>;
  raviTaskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCrmTaskInput extends CrmMutationOptions {
  title: string;
  contactRef?: string | null;
  accountId?: string | null;
  opportunityId?: string | null;
  chatId?: string | null;
  sessionKey?: string | null;
  body?: string | null;
  taskType?: string | null;
  status?: CrmTaskStatus | string | null;
  priority?: CrmPriority | string | null;
  dueAt?: string | null;
  snoozedUntil?: string | null;
  ownerType?: CrmOwnerType | string | null;
  ownerId?: string | null;
  createdByType?: string | null;
  createdById?: string | null;
  metadata?: Record<string, unknown> | null;
  raviTaskId?: string | null;
}

export interface CompleteCrmTaskInput extends CrmMutationOptions {
  taskId: string;
}

export interface CrmNextAction {
  taskId: string;
  title: string;
  taskType: string;
  status: CrmTaskStatus;
  priority: CrmPriority;
  dueAt: string | null;
  contactId: string | null;
  contactName: string | null;
  accountId: string | null;
  accountName: string | null;
  opportunityId: string | null;
  opportunityTitle: string | null;
  ownerType: CrmOwnerType | null;
  ownerId: string | null;
}

export interface ListCrmNextActionsOptions {
  limit?: number | string | null;
  offset?: number | string | null;
  contactRef?: string | null;
  accountId?: string | null;
  opportunityId?: string | null;
  ownerType?: CrmOwnerType | string | null;
  ownerId?: string | null;
}

export interface CrmContactCard {
  contactId: string;
  displayName: string | null;
  kind: "person" | "org";
  policyStatus: ContactStatus | null;
  replyMode: ReplyMode | null;
  tags: string[];
  lifecycle: CrmContactLifecycle | null;
  relationshipHealth: CrmRelationshipHealth | null;
  priority: CrmPriority | null;
  ownerType: CrmOwnerType | null;
  ownerId: string | null;
  primaryAccountId: string | null;
  primaryOpportunityId: string | null;
  lastMeaningfulInteractionAt: string | null;
  nextActionAt: string | null;
  nextActionSummary: string | null;
  nextTaskId: string | null;
  updatedAt: string;
}

export interface ListCrmContactCardsOptions {
  limit?: number | string | null;
  offset?: number | string | null;
  lifecycle?: CrmContactLifecycle | string | null;
  ownerType?: CrmOwnerType | string | null;
  ownerId?: string | null;
}

export interface CrmContactProfileCard {
  contact: CanonicalContact;
  policy: ContactPolicy | null;
  profile: CrmContactProfile | null;
  card: CrmContactCard | null;
  accountMemberships: Array<CrmAccountContact & { account: CrmAccount | null }>;
  opportunities: CrmOpportunity[];
  tasks: CrmTask[];
  nextActions: CrmNextAction[];
  facts: CrmFact[];
}

export interface CrmAccountDetail {
  account: CrmAccount;
  contacts: Array<CrmAccountContact & { contact: CanonicalContact | null }>;
  opportunities: CrmOpportunity[];
  tasks: CrmTask[];
}

export interface CrmOpportunityBoardCard {
  opportunityId: string;
  title: string;
  status: CrmOpportunityStatus;
  priority: CrmPriority;
  valueCents: number | null;
  currency: string;
  probability: number | null;
  expectedCloseAt: string | null;
  pipelineId: string | null;
  stageKey: string | null;
  stageName: string | null;
  stageOrder: number | null;
  accountId: string | null;
  accountName: string | null;
  primaryContactId: string | null;
  primaryContactName: string | null;
  ownerType: CrmOwnerType | null;
  ownerId: string | null;
  updatedAt: string;
}

export interface ProjectContactEventToCrmActivityInput extends CrmMutationOptions {
  contactEventId: string;
  activityType?: string | null;
  title?: string | null;
  summary?: string | null;
  body?: string | null;
  accountId?: string | null;
  opportunityId?: string | null;
  taskId?: string | null;
}

export interface CrmActivity {
  id: string;
  activityType: string;
  title: string | null;
  summary: string;
  body: string | null;
  occurredAt: string;
  contactId: string | null;
  accountId: string | null;
  opportunityId: string | null;
  taskId: string | null;
  chatId: string | null;
  sessionKey: string | null;
  messageId: string | null;
  contactEventId: string | null;
  sessionEventId: string | null;
  actorType: string;
  actorId: string | null;
  source: string;
  idempotencyKey: string | null;
  confidence: number;
  evidence: unknown;
  payload: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface CrmActivityParticipant {
  id: string;
  activityId: string;
  contactId: string | null;
  accountId: string | null;
  role: string;
  actorType: string | null;
  actorId: string | null;
  source: string;
  confidence: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface LinkCrmActivityParticipantInput extends CrmMutationOptions {
  activityId: string;
  contactRef?: string | null;
  accountId?: string | null;
  role?: string | null;
  metadata?: Record<string, unknown> | null;
}

export type CrmFactStatus = "proposed" | "confirmed" | "rejected" | "superseded";

export interface CrmFact {
  id: string;
  entityType: CrmEntityType;
  entityId: string;
  contactId: string | null;
  accountId: string | null;
  opportunityId: string | null;
  key: string;
  value: unknown;
  status: CrmFactStatus;
  source: string;
  idempotencyKey: string | null;
  confidence: number;
  evidence: unknown;
  scopeType: CrmScopeType;
  scopeId: string | null;
  proposedByType: string | null;
  proposedById: string | null;
  confirmedByType: string | null;
  confirmedById: string | null;
  supersedesFactId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ProposeCrmFactInput extends CrmMutationOptions {
  entityType: CrmEntityType | string;
  entityId: string;
  key: string;
  value: unknown;
  status?: CrmFactStatus | string | null;
  contactRef?: string | null;
  accountId?: string | null;
  opportunityId?: string | null;
  supersedesFactId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface UpdateCrmFactStatusInput extends CrmMutationOptions {
  factId: string;
}

export interface ListCrmFactsOptions {
  limit?: number | string | null;
  offset?: number | string | null;
  entityType?: CrmEntityType | string | null;
  entityId?: string | null;
  contactRef?: string | null;
  accountId?: string | null;
  opportunityId?: string | null;
  status?: CrmFactStatus | string | null;
  key?: string | null;
}

export interface ContactMetadataMutationOptions {
  scopeType?: ContactEventScopeType | string | null;
  scopeId?: string | null;
  source?: string | null;
  actorType?: ContactEventActorType | null;
  actorId?: string | null;
  confidence?: number | null;
  evidence?: unknown;
}

export interface ContactContextEntry {
  contactId: string;
  scopeType: ContactEventScopeType;
  scopeId: string | null;
  key: string;
  value: unknown;
  source: string | null;
  confidence: number | null;
  updatedByType: string | null;
  updatedById: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContactMetadataRemoveResult {
  removed: boolean;
  previous: ContactContextEntry | null;
  event: ContactEvent | null;
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

interface ContactEventRow {
  id: string;
  contact_id: string;
  event_type: string;
  scope_type: ContactEventScopeType;
  scope_id: string | null;
  source: string | null;
  actor_type: ContactEventActorType | null;
  actor_id: string | null;
  platform_identity_id: string | null;
  chat_id: string | null;
  session_key: string | null;
  message_id: string | null;
  task_id: string | null;
  artifact_id: string | null;
  confidence: number | null;
  payload_json: string | null;
  evidence_json: string | null;
  created_at: string;
  effective_at: string | null;
}

interface CrmEventRow {
  id: string;
  event_type: string;
  entity_type: CrmEntityType;
  entity_id: string;
  contact_id: string | null;
  account_id: string | null;
  opportunity_id: string | null;
  task_id: string | null;
  activity_id: string | null;
  actor_type: string;
  actor_id: string | null;
  scope_type: CrmScopeType;
  scope_id: string | null;
  source: string;
  idempotency_key: string | null;
  confidence: number;
  payload_json: string;
  previous_payload_json: string | null;
  evidence_json: string | null;
  created_at: string;
}

interface CrmContactProfileRow {
  contact_id: string;
  lifecycle: CrmContactLifecycle;
  relationship_health: CrmRelationshipHealth;
  priority: CrmPriority;
  score: number | null;
  health_score: number | null;
  owner_type: CrmOwnerType | null;
  owner_id: string | null;
  primary_account_id: string | null;
  primary_opportunity_id: string | null;
  lead_source: string | null;
  persona: string | null;
  buying_role: string | null;
  last_meaningful_interaction_at: string | null;
  next_action_at: string | null;
  next_action_summary: string | null;
  next_task_id: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

interface CrmAccountRow {
  id: string;
  org_contact_id: string | null;
  name: string;
  legal_name: string | null;
  domain: string | null;
  website_url: string | null;
  industry: string | null;
  size_label: string | null;
  lifecycle: CrmContactLifecycle;
  relationship_health: CrmRelationshipHealth;
  priority: CrmPriority;
  owner_type: CrmOwnerType | null;
  owner_id: string | null;
  source: string;
  idempotency_key: string | null;
  confidence: number;
  metadata_json: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface CrmAccountContactRow {
  id: string;
  account_id: string;
  contact_id: string;
  role: string;
  title: string | null;
  department: string | null;
  decision_role: string;
  relationship_strength: string;
  is_primary: number;
  status: string;
  source: string;
  confidence: number;
  evidence_json: string | null;
  metadata_json: string;
  first_seen_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
}

interface CrmPipelineStageRow {
  id: string;
  pipeline_id: string;
  key: string;
  name: string;
  sort_order: number;
  category: string;
  probability: number | null;
  is_terminal: number;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

interface CrmOpportunityRow {
  id: string;
  account_id: string | null;
  primary_contact_id: string | null;
  pipeline_id: string | null;
  stage_id: string | null;
  title: string;
  description: string | null;
  status: CrmOpportunityStatus;
  priority: CrmPriority;
  value_cents: number | null;
  currency: string;
  probability: number | null;
  expected_close_at: string | null;
  closed_at: string | null;
  lost_reason: string | null;
  owner_type: CrmOwnerType | null;
  owner_id: string | null;
  source: string;
  idempotency_key: string | null;
  confidence: number;
  evidence_json: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface CrmOpportunityContactRow {
  id: string;
  opportunity_id: string;
  contact_id: string;
  account_id: string | null;
  role: string;
  influence: string;
  sentiment: string;
  is_primary: number;
  source: string;
  confidence: number;
  evidence_json: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

interface CrmTaskRow {
  id: string;
  contact_id: string | null;
  account_id: string | null;
  opportunity_id: string | null;
  chat_id: string | null;
  session_key: string | null;
  title: string;
  body: string | null;
  task_type: string;
  status: CrmTaskStatus;
  priority: CrmPriority;
  due_at: string | null;
  snoozed_until: string | null;
  completed_at: string | null;
  canceled_at: string | null;
  owner_type: CrmOwnerType | null;
  owner_id: string | null;
  created_by_type: string;
  created_by_id: string | null;
  source: string;
  idempotency_key: string | null;
  confidence: number;
  evidence_json: string | null;
  metadata_json: string;
  ravi_task_id: string | null;
  created_at: string;
  updated_at: string;
}

interface CrmNextActionRow {
  task_id: string;
  title: string;
  task_type: string;
  status: CrmTaskStatus;
  priority: CrmPriority;
  due_at: string | null;
  contact_id: string | null;
  contact_name: string | null;
  account_id: string | null;
  account_name: string | null;
  opportunity_id: string | null;
  opportunity_title: string | null;
  owner_type: CrmOwnerType | null;
  owner_id: string | null;
}

interface CrmContactCardRow {
  contact_id: string;
  display_name: string | null;
  kind: "person" | "org";
  policy_status: ContactStatus | null;
  reply_mode: ReplyMode | null;
  tags_json: string | null;
  lifecycle: CrmContactLifecycle | null;
  relationship_health: CrmRelationshipHealth | null;
  priority: CrmPriority | null;
  owner_type: CrmOwnerType | null;
  owner_id: string | null;
  primary_account_id: string | null;
  primary_opportunity_id: string | null;
  last_meaningful_interaction_at: string | null;
  next_action_at: string | null;
  next_action_summary: string | null;
  next_task_id: string | null;
  updated_at: string;
}

interface CrmOpportunityBoardRow {
  opportunity_id: string;
  title: string;
  status: CrmOpportunityStatus;
  priority: CrmPriority;
  value_cents: number | null;
  currency: string;
  probability: number | null;
  expected_close_at: string | null;
  pipeline_id: string | null;
  stage_key: string | null;
  stage_name: string | null;
  stage_order: number | null;
  account_id: string | null;
  account_name: string | null;
  primary_contact_id: string | null;
  primary_contact_name: string | null;
  owner_type: CrmOwnerType | null;
  owner_id: string | null;
  updated_at: string;
}

interface CrmActivityRow {
  id: string;
  activity_type: string;
  title: string | null;
  summary: string;
  body: string | null;
  occurred_at: string;
  contact_id: string | null;
  account_id: string | null;
  opportunity_id: string | null;
  task_id: string | null;
  chat_id: string | null;
  session_key: string | null;
  message_id: string | null;
  contact_event_id: string | null;
  session_event_id: string | null;
  actor_type: string;
  actor_id: string | null;
  source: string;
  idempotency_key: string | null;
  confidence: number;
  evidence_json: string | null;
  payload_json: string;
  created_at: string;
  updated_at: string;
}

interface CrmActivityParticipantRow {
  id: string;
  activity_id: string;
  contact_id: string | null;
  account_id: string | null;
  role: string;
  actor_type: string | null;
  actor_id: string | null;
  source: string;
  confidence: number;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

interface CrmFactRow {
  id: string;
  entity_type: CrmEntityType;
  entity_id: string;
  contact_id: string | null;
  account_id: string | null;
  opportunity_id: string | null;
  key: string;
  value_json: string;
  status: CrmFactStatus;
  source: string;
  idempotency_key: string | null;
  confidence: number;
  evidence_json: string | null;
  scope_type: CrmScopeType;
  scope_id: string | null;
  proposed_by_type: string | null;
  proposed_by_id: string | null;
  confirmed_by_type: string | null;
  confirmed_by_id: string | null;
  supersedes_fact_id: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

interface ContactContextRow {
  contact_id: string;
  scope_type: ContactEventScopeType;
  scope_id: string;
  key: string;
  value_json: string;
  source: string | null;
  confidence: number | null;
  updated_by_type: string | null;
  updated_by_id: string | null;
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

const CONTACT_RECENCY_ORDER_SQL = `
  CASE
    WHEN last_inbound_at IS NOT NULL AND last_outbound_at IS NOT NULL THEN
      CASE
        WHEN last_inbound_at >= last_outbound_at THEN last_inbound_at
        ELSE last_outbound_at
      END
    ELSE COALESCE(last_inbound_at, last_outbound_at, updated_at, created_at)
  END DESC,
  updated_at DESC,
  created_at DESC,
  id DESC
`;

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
    getAllContacts: database.prepare(`SELECT * FROM contacts_v2 ORDER BY ${CONTACT_RECENCY_ORDER_SQL}`),
    getContactsByStatus: database.prepare(
      `SELECT * FROM contacts_v2 WHERE status = ? ORDER BY ${CONTACT_RECENCY_ORDER_SQL}`,
    ),
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
    tags: contactTags(row.id, row.tags),
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
    tags: contactTags(row.contact_id, row.tags_json),
    notes: parseJsonObject(row.notes_json) ?? {},
    source: (row.source as ContactSource) ?? null,
    lastInboundAt: row.last_inbound_at,
    lastOutboundAt: row.last_outbound_at,
    interactionCount: row.interaction_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeContactEventScope(
  scopeType?: ContactEventScopeType | string | null,
  scopeId?: string | null,
): { scopeType: ContactEventScopeType; scopeId: string | null; storageScopeId: string } {
  const resolvedScopeType = (scopeType?.trim().toLowerCase() || "global") as ContactEventScopeType;
  if (!CONTACT_EVENT_SCOPE_TYPES.has(resolvedScopeType)) {
    throw new Error(`Invalid contact event scope type: ${scopeType}`);
  }
  const resolvedScopeId = scopeId?.trim() || null;
  if (resolvedScopeType !== "global" && !resolvedScopeId) {
    throw new Error(`scope_id is required for contact event scope ${resolvedScopeType}`);
  }
  if (resolvedScopeType === "global" && resolvedScopeId) {
    throw new Error("scope_id must be empty when contact event scope is global");
  }
  return {
    scopeType: resolvedScopeType,
    scopeId: resolvedScopeId,
    storageScopeId: resolvedScopeId ?? "",
  };
}

function normalizeContactEventType(eventType: string): string {
  const normalized = eventType.trim();
  if (!normalized) throw new Error("Contact event type is required");
  return normalized;
}

function normalizeContactContextKey(key: string): string {
  const normalized = key.trim();
  if (!normalized) throw new Error("Contact metadata key is required");
  return normalized;
}

function normalizeContactEventActorType(actorType?: ContactEventActorType | null): ContactEventActorType | null {
  return actorType ?? null;
}

function normalizeCrmEventType(eventType: string): string {
  const normalized = eventType.trim();
  if (!normalized) throw new Error("CRM event type is required");
  return normalized;
}

function normalizeCrmEntityType(entityType: string): CrmEntityType {
  const normalized = entityType.trim().toLowerCase();
  if (!CRM_ENTITY_TYPES.has(normalized)) {
    throw new Error(`Invalid CRM entity type: ${entityType}`);
  }
  return normalized as CrmEntityType;
}

function normalizeCrmScope(
  scopeType?: CrmScopeType | string | null,
  scopeId?: string | null,
): { scopeType: CrmScopeType; scopeId: string | null } {
  const resolvedScopeType = (scopeType?.trim().toLowerCase() || "global") as CrmScopeType;
  if (!CRM_EVENT_SCOPE_TYPES.has(resolvedScopeType)) {
    throw new Error(`Invalid CRM event scope type: ${scopeType}`);
  }
  const resolvedScopeId = scopeId?.trim() || null;
  if (resolvedScopeType !== "global" && !resolvedScopeId) {
    throw new Error(`scope_id is required for CRM event scope ${resolvedScopeType}`);
  }
  if (resolvedScopeType === "global" && resolvedScopeId) {
    throw new Error("scope_id must be empty when CRM event scope is global");
  }
  return { scopeType: resolvedScopeType, scopeId: resolvedScopeId };
}

function normalizeCrmConfidence(confidence?: number | null): number {
  const resolved = confidence ?? 1;
  if (!Number.isFinite(resolved) || resolved < 0 || resolved > 1) {
    throw new Error("CRM event confidence must be between 0 and 1");
  }
  return resolved;
}

function normalizeCrmActorType(actorType?: CrmActorType | string | null): string {
  return actorType?.trim() || "system";
}

function crmEventJson(value: unknown, fallback: unknown = null): string | null {
  if (value === undefined) {
    return fallback === null ? null : JSON.stringify(fallback);
  }
  return JSON.stringify(value);
}

function normalizeCrmIdempotencyKey(value?: string | null): string | null {
  return normalizeOptionalText(value);
}

function getCrmEventRowByIdempotencyKey(database: Database, idempotencyKey: string): CrmEventRow | null {
  const row = database.prepare("SELECT * FROM crm_events WHERE idempotency_key = ?").get(idempotencyKey) as
    | CrmEventRow
    | undefined;
  return row ?? null;
}

function getCrmFactStatus(value?: CrmFactStatus | string | null, fallback: CrmFactStatus = "proposed"): CrmFactStatus {
  return normalizeCrmEnum<CrmFactStatus>(value, CRM_FACT_STATUSES, fallback);
}

function rowToContactEvent(row: ContactEventRow): ContactEvent {
  return {
    id: row.id,
    contactId: row.contact_id,
    eventType: row.event_type,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    source: row.source,
    actorType: row.actor_type,
    actorId: row.actor_id,
    platformIdentityId: row.platform_identity_id,
    chatId: row.chat_id,
    sessionKey: row.session_key,
    messageId: row.message_id,
    taskId: row.task_id,
    artifactId: row.artifact_id,
    confidence: row.confidence,
    payload: parseJsonValue(row.payload_json),
    evidence: parseJsonValue(row.evidence_json),
    createdAt: row.created_at,
    effectiveAt: row.effective_at,
  };
}

function rowToCrmEvent(row: CrmEventRow): CrmEvent {
  return {
    id: row.id,
    eventType: row.event_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    contactId: row.contact_id,
    accountId: row.account_id,
    opportunityId: row.opportunity_id,
    taskId: row.task_id,
    activityId: row.activity_id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    source: row.source,
    idempotencyKey: row.idempotency_key,
    confidence: row.confidence,
    payload: parseJsonValue(row.payload_json),
    previousPayload: parseJsonValue(row.previous_payload_json),
    evidence: parseJsonValue(row.evidence_json),
    createdAt: row.created_at,
  };
}

function normalizeCrmEnum<T extends string>(value: string | null | undefined, allowed: Set<string>, fallback: T): T {
  const normalized = value?.trim().toLowerCase() || fallback;
  if (!allowed.has(normalized)) {
    throw new Error(`Invalid CRM value: ${value}`);
  }
  return normalized as T;
}

function normalizeOptionalCrmOwner(input: {
  ownerType?: CrmOwnerType | string | null;
  ownerId?: string | null;
  previousOwnerType?: CrmOwnerType | null;
  previousOwnerId?: string | null;
}): { ownerType: CrmOwnerType | null; ownerId: string | null } {
  const ownerType =
    input.ownerType === undefined
      ? (input.previousOwnerType ?? null)
      : input.ownerType === null || input.ownerType.trim() === ""
        ? null
        : normalizeCrmEnum<CrmOwnerType>(input.ownerType, CRM_OWNER_TYPES, "system");
  const ownerId =
    input.ownerId === undefined
      ? (input.previousOwnerId ?? null)
      : input.ownerId === null || input.ownerId.trim() === ""
        ? null
        : input.ownerId.trim();

  if ((ownerType === null) !== (ownerId === null)) {
    throw new Error("CRM owner_type and owner_id must be set or cleared together");
  }
  return { ownerType, ownerId };
}

function normalizeOptionalText(value: string | null | undefined, previous: string | null = null): string | null {
  if (value === undefined) return previous;
  const trimmed = value?.trim() || "";
  return trimmed ? trimmed : null;
}

function normalizeRequiredText(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}

function normalizeOptionalNumber(value: number | null | undefined, label: string, previous: number | null = null) {
  if (value === undefined) return previous;
  if (value === null) return null;
  if (!Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

function normalizeProbability(value: number | null | undefined, previous: number | null = null): number | null {
  const resolved = normalizeOptionalNumber(value, "probability", previous);
  if (resolved !== null && (resolved < 0 || resolved > 1)) {
    throw new Error("probability must be between 0 and 1");
  }
  return resolved;
}

function normalizeMetadataObject(
  value: Record<string, unknown> | null | undefined,
  previous = "{}",
): Record<string, unknown> {
  if (value === undefined) return parseJsonObject(previous) ?? {};
  return value ?? {};
}

function jsonObject(value: Record<string, unknown> | null | undefined): string {
  return JSON.stringify(value ?? {});
}

function rowToCrmContactProfile(row: CrmContactProfileRow): CrmContactProfile {
  return {
    contactId: row.contact_id,
    lifecycle: row.lifecycle,
    relationshipHealth: row.relationship_health,
    priority: row.priority,
    score: row.score,
    healthScore: row.health_score,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    primaryAccountId: row.primary_account_id,
    primaryOpportunityId: row.primary_opportunity_id,
    leadSource: row.lead_source,
    persona: row.persona,
    buyingRole: row.buying_role,
    lastMeaningfulInteractionAt: row.last_meaningful_interaction_at,
    nextActionAt: row.next_action_at,
    nextActionSummary: row.next_action_summary,
    nextTaskId: row.next_task_id,
    metadata: parseJsonObject(row.metadata_json) ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToCrmAccount(row: CrmAccountRow): CrmAccount {
  return {
    id: row.id,
    orgContactId: row.org_contact_id,
    name: row.name,
    legalName: row.legal_name,
    domain: row.domain,
    websiteUrl: row.website_url,
    industry: row.industry,
    sizeLabel: row.size_label,
    lifecycle: row.lifecycle,
    relationshipHealth: row.relationship_health,
    priority: row.priority,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    source: row.source,
    idempotencyKey: row.idempotency_key,
    confidence: row.confidence,
    metadata: parseJsonObject(row.metadata_json) ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function rowToCrmAccountContact(row: CrmAccountContactRow): CrmAccountContact {
  return {
    id: row.id,
    accountId: row.account_id,
    contactId: row.contact_id,
    role: row.role,
    title: row.title,
    department: row.department,
    decisionRole: row.decision_role,
    relationshipStrength: row.relationship_strength,
    isPrimary: row.is_primary === 1,
    status: row.status,
    source: row.source,
    confidence: row.confidence,
    evidence: parseJsonValue(row.evidence_json),
    metadata: parseJsonObject(row.metadata_json) ?? {},
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToCrmPipelineStage(row: CrmPipelineStageRow): CrmPipelineStage {
  return {
    id: row.id,
    pipelineId: row.pipeline_id,
    key: row.key,
    name: row.name,
    sortOrder: row.sort_order,
    category: row.category,
    probability: row.probability,
    isTerminal: row.is_terminal === 1,
    metadata: parseJsonObject(row.metadata_json) ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToCrmOpportunity(row: CrmOpportunityRow): CrmOpportunity {
  return {
    id: row.id,
    accountId: row.account_id,
    primaryContactId: row.primary_contact_id,
    pipelineId: row.pipeline_id,
    stageId: row.stage_id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    valueCents: row.value_cents,
    currency: row.currency,
    probability: row.probability,
    expectedCloseAt: row.expected_close_at,
    closedAt: row.closed_at,
    lostReason: row.lost_reason,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    source: row.source,
    idempotencyKey: row.idempotency_key,
    confidence: row.confidence,
    evidence: parseJsonValue(row.evidence_json),
    metadata: parseJsonObject(row.metadata_json) ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function rowToCrmOpportunityContact(row: CrmOpportunityContactRow): CrmOpportunityContact {
  return {
    id: row.id,
    opportunityId: row.opportunity_id,
    contactId: row.contact_id,
    accountId: row.account_id,
    role: row.role,
    influence: row.influence,
    sentiment: row.sentiment,
    isPrimary: row.is_primary === 1,
    source: row.source,
    confidence: row.confidence,
    evidence: parseJsonValue(row.evidence_json),
    metadata: parseJsonObject(row.metadata_json) ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToCrmTask(row: CrmTaskRow): CrmTask {
  return {
    id: row.id,
    contactId: row.contact_id,
    accountId: row.account_id,
    opportunityId: row.opportunity_id,
    chatId: row.chat_id,
    sessionKey: row.session_key,
    title: row.title,
    body: row.body,
    taskType: row.task_type,
    status: row.status,
    priority: row.priority,
    dueAt: row.due_at,
    snoozedUntil: row.snoozed_until,
    completedAt: row.completed_at,
    canceledAt: row.canceled_at,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    createdByType: row.created_by_type,
    createdById: row.created_by_id,
    source: row.source,
    idempotencyKey: row.idempotency_key,
    confidence: row.confidence,
    evidence: parseJsonValue(row.evidence_json),
    metadata: parseJsonObject(row.metadata_json) ?? {},
    raviTaskId: row.ravi_task_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToCrmNextAction(row: CrmNextActionRow): CrmNextAction {
  return {
    taskId: row.task_id,
    title: row.title,
    taskType: row.task_type,
    status: row.status,
    priority: row.priority,
    dueAt: row.due_at,
    contactId: row.contact_id,
    contactName: row.contact_name,
    accountId: row.account_id,
    accountName: row.account_name,
    opportunityId: row.opportunity_id,
    opportunityTitle: row.opportunity_title,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
  };
}

function rowToCrmContactCard(row: CrmContactCardRow): CrmContactCard {
  return {
    contactId: row.contact_id,
    displayName: row.display_name,
    kind: row.kind,
    policyStatus: row.policy_status,
    replyMode: row.reply_mode,
    tags: legacyContactTagsFromJson(row.tags_json),
    lifecycle: row.lifecycle,
    relationshipHealth: row.relationship_health,
    priority: row.priority,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    primaryAccountId: row.primary_account_id,
    primaryOpportunityId: row.primary_opportunity_id,
    lastMeaningfulInteractionAt: row.last_meaningful_interaction_at,
    nextActionAt: row.next_action_at,
    nextActionSummary: row.next_action_summary,
    nextTaskId: row.next_task_id,
    updatedAt: row.updated_at,
  };
}

function rowToCrmOpportunityBoardCard(row: CrmOpportunityBoardRow): CrmOpportunityBoardCard {
  return {
    opportunityId: row.opportunity_id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    valueCents: row.value_cents,
    currency: row.currency,
    probability: row.probability,
    expectedCloseAt: row.expected_close_at,
    pipelineId: row.pipeline_id,
    stageKey: row.stage_key,
    stageName: row.stage_name,
    stageOrder: row.stage_order,
    accountId: row.account_id,
    accountName: row.account_name,
    primaryContactId: row.primary_contact_id,
    primaryContactName: row.primary_contact_name,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    updatedAt: row.updated_at,
  };
}

function rowToCrmActivity(row: CrmActivityRow): CrmActivity {
  return {
    id: row.id,
    activityType: row.activity_type,
    title: row.title,
    summary: row.summary,
    body: row.body,
    occurredAt: row.occurred_at,
    contactId: row.contact_id,
    accountId: row.account_id,
    opportunityId: row.opportunity_id,
    taskId: row.task_id,
    chatId: row.chat_id,
    sessionKey: row.session_key,
    messageId: row.message_id,
    contactEventId: row.contact_event_id,
    sessionEventId: row.session_event_id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    source: row.source,
    idempotencyKey: row.idempotency_key,
    confidence: row.confidence,
    evidence: parseJsonValue(row.evidence_json),
    payload: parseJsonValue(row.payload_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToCrmActivityParticipant(row: CrmActivityParticipantRow): CrmActivityParticipant {
  return {
    id: row.id,
    activityId: row.activity_id,
    contactId: row.contact_id,
    accountId: row.account_id,
    role: row.role,
    actorType: row.actor_type,
    actorId: row.actor_id,
    source: row.source,
    confidence: row.confidence,
    metadata: parseJsonObject(row.metadata_json) ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToCrmFact(row: CrmFactRow): CrmFact {
  return {
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    contactId: row.contact_id,
    accountId: row.account_id,
    opportunityId: row.opportunity_id,
    key: row.key,
    value: parseJsonValue(row.value_json),
    status: row.status,
    source: row.source,
    idempotencyKey: row.idempotency_key,
    confidence: row.confidence,
    evidence: parseJsonValue(row.evidence_json),
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    proposedByType: row.proposed_by_type,
    proposedById: row.proposed_by_id,
    confirmedByType: row.confirmed_by_type,
    confirmedById: row.confirmed_by_id,
    supersedesFactId: row.supersedes_fact_id,
    metadata: parseJsonObject(row.metadata_json) ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function contactEventSubjectToken(eventType: string): string {
  return eventType.replace(/[^A-Za-z0-9_.-]/g, "_") || "unknown";
}

function contactEventNatsPayload(event: ContactEvent, options: { minimized?: boolean } = {}): Record<string, unknown> {
  const base = {
    event_id: event.id,
    event_type: event.eventType,
    contact_id: event.contactId,
    source: event.source,
    scope_type: event.scopeType,
    scope_id: event.scopeId,
    confidence: event.confidence,
    created_at: event.createdAt,
    effective_at: event.effectiveAt,
  };
  if (options.minimized) {
    return { ...base, actor_type: event.actorType, actor_id: null, redacted: true };
  }
  return {
    ...base,
    actor_type: event.actorType,
    actor_id: event.actorId,
    payload: event.payload,
    evidence: event.evidence,
    platform_identity_id: event.platformIdentityId,
    chat_id: event.chatId,
    session_key: event.sessionKey,
    message_id: event.messageId,
    task_id: event.taskId,
    artifact_id: event.artifactId,
  };
}

function emitContactTimelineEvent(event: ContactEvent): void {
  const eventType = contactEventSubjectToken(event.eventType);
  nats.emit(`ravi.contacts.events.${eventType}`, contactEventNatsPayload(event, { minimized: true })).catch(() => {});
  nats.emit(`ravi.contacts.${event.contactId}.events.${eventType}`, contactEventNatsPayload(event)).catch(() => {});
}

function rowToContactContext(row: ContactContextRow): ContactContextEntry {
  return {
    contactId: row.contact_id,
    scopeType: row.scope_type,
    scopeId: row.scope_id || null,
    key: row.key,
    value: parseJsonValue(row.value_json),
    source: row.source,
    confidence: row.confidence,
    updatedByType: row.updated_by_type,
    updatedById: row.updated_by_id,
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

function resolveCanonicalContactId(database: Database, contactRef: string): string | null {
  const legacyContact = resolveContact(contactRef);
  if (legacyContact) {
    if (isLegacyGroupOnlyContact(legacyContact)) return null;
    if (!contactProjectionIsCurrent(database, legacyContact)) {
      syncContactProjection(database, legacyContact.id);
    }
    return legacyContact.id;
  }

  if (getCanonicalContactById(database, contactRef)) return contactRef;

  const identity = findPlatformIdentityByRef(database, contactRef);
  if (identity?.owner_type === "contact" && identity.owner_id) return identity.owner_id;

  return null;
}

type InsertContactEventInput = Omit<CreateContactEventInput, "contactRef"> & { contactId: string };

function insertContactEvent(database: Database, input: InsertContactEventInput): ContactEvent {
  const scope = normalizeContactEventScope(input.scopeType, input.scopeId);
  const eventType = normalizeContactEventType(input.eventType);
  const id = `ce_${generateId()}`;
  const payloadJson = input.payload === undefined ? null : JSON.stringify(input.payload);
  const evidenceJson = input.evidence === undefined ? null : JSON.stringify(input.evidence);

  database
    .prepare(
      `
      INSERT INTO contact_events (
        id, contact_id, event_type, scope_type, scope_id, source, actor_type, actor_id,
        platform_identity_id, chat_id, session_key, message_id, task_id, artifact_id,
        confidence, payload_json, evidence_json, effective_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      id,
      input.contactId,
      eventType,
      scope.scopeType,
      scope.scopeId,
      input.source?.trim() || null,
      normalizeContactEventActorType(input.actorType),
      input.actorId?.trim() || null,
      input.platformIdentityId?.trim() || null,
      input.chatId?.trim() || null,
      input.sessionKey?.trim() || null,
      input.messageId?.trim() || null,
      input.taskId?.trim() || null,
      input.artifactId?.trim() || null,
      input.confidence ?? null,
      payloadJson,
      evidenceJson,
      input.effectiveAt?.trim() || null,
    );

  const row = database.prepare("SELECT * FROM contact_events WHERE id = ?").get(id) as ContactEventRow | undefined;
  if (!row) throw new Error(`Contact event not found after insert: ${id}`);
  const event = rowToContactEvent(row);
  emitContactTimelineEvent(event);
  return event;
}

export function createContactEvent(input: CreateContactEventInput): ContactEvent {
  const database = ensureDb();
  const contactId = resolveCanonicalContactId(database, input.contactRef);
  if (!contactId) throw new Error(`Contact not found: ${input.contactRef}`);
  return insertContactEvent(database, { ...input, contactId });
}

function crmActorTypeToContactActor(actorType: string): ContactEventActorType {
  if (actorType === "user" || actorType === "agent" || actorType === "system" || actorType === "contact") {
    return actorType;
  }
  return actorType === "unknown" ? "unknown" : "system";
}

function insertCrmEvent(database: Database, input: CreateCrmEventInput): CrmEvent {
  const eventType = normalizeCrmEventType(input.eventType);
  const entityType = normalizeCrmEntityType(input.entityType);
  const entityId = input.entityId.trim();
  if (!entityId) throw new Error("CRM event entity_id is required");

  const source = input.source.trim();
  if (!source) throw new Error("CRM event source is required");

  const contactId = input.contactId?.trim() || (entityType === "contact" ? entityId : null);
  const accountId = input.accountId?.trim() || (entityType === "account" ? entityId : null);
  const opportunityId = input.opportunityId?.trim() || (entityType === "opportunity" ? entityId : null);
  const taskId = input.taskId?.trim() || (entityType === "task" ? entityId : null);
  const activityId = input.activityId?.trim() || (entityType === "activity" ? entityId : null);
  const actorType = normalizeCrmActorType(input.actorType);
  const actorId = input.actorId?.trim() || null;
  const scope = normalizeCrmScope(input.scopeType, input.scopeId);
  const confidence = normalizeCrmConfidence(input.confidence);
  const idempotencyKey = normalizeCrmIdempotencyKey(input.idempotencyKey);
  if (idempotencyKey) {
    const existing = getCrmEventRowByIdempotencyKey(database, idempotencyKey);
    if (existing) return rowToCrmEvent(existing);
  }
  const id = `crm_evt_${generateId()}`;
  const payloadJson = crmEventJson(input.payload, {}) ?? "{}";
  const previousPayloadJson = crmEventJson(input.previousPayload);
  const evidenceJson = crmEventJson(input.evidence);

  database
    .prepare(
      `
      INSERT INTO crm_events (
        id, event_type, entity_type, entity_id, contact_id, account_id, opportunity_id, task_id, activity_id,
        actor_type, actor_id, scope_type, scope_id, source, idempotency_key, confidence, payload_json, previous_payload_json,
        evidence_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      id,
      eventType,
      entityType,
      entityId,
      contactId,
      accountId,
      opportunityId,
      taskId,
      activityId,
      actorType,
      actorId,
      scope.scopeType,
      scope.scopeId,
      source,
      idempotencyKey,
      confidence,
      payloadJson,
      previousPayloadJson,
      evidenceJson,
    );

  const row = database.prepare("SELECT * FROM crm_events WHERE id = ?").get(id) as CrmEventRow | undefined;
  if (!row) throw new Error(`CRM event not found after insert: ${id}`);
  const event = rowToCrmEvent(row);

  if (contactId && input.emitContactEvent !== false) {
    insertContactEvent(database, {
      contactId,
      eventType: input.contactEventType?.trim() || eventType,
      scopeType: "domain",
      scopeId: "crm",
      source,
      actorType: crmActorTypeToContactActor(actorType),
      actorId,
      confidence,
      taskId,
      payload: {
        crmEventId: id,
        crmEventType: eventType,
        entityType,
        entityId,
        contactId,
        accountId,
        opportunityId,
        taskId,
        activityId,
        payload: input.payload ?? {},
      },
      evidence: {
        crmEventId: id,
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        previousPayload: input.previousPayload ?? null,
        evidence: input.evidence ?? null,
      },
    });
  }

  return event;
}

export function createCrmEvent(input: CreateCrmEventInput): CrmEvent {
  const database = ensureDb();
  const txn = database.transaction(() => insertCrmEvent(database, input));
  return txn();
}

function crmMutationSource(options: CrmMutationOptions): string {
  return options.source?.trim() || "api";
}

function resolveRequiredCanonicalContactId(database: Database, contactRef: string, label = "Contact"): string {
  const contactId = resolveCanonicalContactId(database, contactRef);
  if (!contactId) throw new Error(`${label} not found: ${contactRef}`);
  return contactId;
}

function getCrmContactProfileRow(database: Database, contactId: string): CrmContactProfileRow | null {
  const row = database.prepare("SELECT * FROM crm_contact_profiles WHERE contact_id = ?").get(contactId) as
    | CrmContactProfileRow
    | undefined;
  return row ?? null;
}

function getCrmAccountRow(database: Database, accountRef: string): CrmAccountRow | null {
  const row = database
    .prepare("SELECT * FROM crm_accounts WHERE id = ? OR org_contact_id = ? LIMIT 1")
    .get(accountRef, accountRef) as CrmAccountRow | undefined;
  return row ?? null;
}

function getCrmOpportunityRow(database: Database, opportunityId: string): CrmOpportunityRow | null {
  const row = database.prepare("SELECT * FROM crm_opportunities WHERE id = ?").get(opportunityId) as
    | CrmOpportunityRow
    | undefined;
  return row ?? null;
}

function getCrmTaskRow(database: Database, taskId: string): CrmTaskRow | null {
  const row = database.prepare("SELECT * FROM crm_tasks WHERE id = ?").get(taskId) as CrmTaskRow | undefined;
  return row ?? null;
}

function getCrmActivityRow(database: Database, activityId: string): CrmActivityRow | null {
  const row = database.prepare("SELECT * FROM crm_activities WHERE id = ?").get(activityId) as
    | CrmActivityRow
    | undefined;
  return row ?? null;
}

function requireCrmAccount(database: Database, accountId: string): CrmAccountRow {
  const account = getCrmAccountRow(database, accountId);
  if (!account) throw new Error(`CRM account not found: ${accountId}`);
  return account;
}

function requireCrmOpportunity(database: Database, opportunityId: string): CrmOpportunityRow {
  const opportunity = getCrmOpportunityRow(database, opportunityId);
  if (!opportunity) throw new Error(`CRM opportunity not found: ${opportunityId}`);
  return opportunity;
}

function requireCrmTask(database: Database, taskId: string): CrmTaskRow {
  const task = getCrmTaskRow(database, taskId);
  if (!task) throw new Error(`CRM task not found: ${taskId}`);
  return task;
}

function requireCrmActivity(database: Database, activityId: string): CrmActivityRow {
  const activity = getCrmActivityRow(database, activityId);
  if (!activity) throw new Error(`CRM activity not found: ${activityId}`);
  return activity;
}

function upsertContactContextProjection(database: Database, contactId: string, key: string, value: unknown): void {
  database
    .prepare(
      `
      INSERT INTO contact_contexts (
        contact_id, scope_type, scope_id, key, value_json, source, confidence,
        updated_by_type, updated_by_id, created_at, updated_at
      )
      VALUES (?, 'domain', 'crm', ?, ?, 'crm_projection', 1, 'system', 'crm', datetime('now'), datetime('now'))
      ON CONFLICT(contact_id, scope_type, scope_id, key) DO UPDATE SET
        value_json = excluded.value_json,
        source = excluded.source,
        confidence = excluded.confidence,
        updated_by_type = excluded.updated_by_type,
        updated_by_id = excluded.updated_by_id,
        updated_at = datetime('now')
    `,
    )
    .run(contactId, key, JSON.stringify(value));
}

function projectCrmContactProfileMetadata(database: Database, profile: CrmContactProfile): void {
  upsertContactContextProjection(database, profile.contactId, "crm.lifecycle", profile.lifecycle);
  upsertContactContextProjection(database, profile.contactId, "crm.relationship_health", profile.relationshipHealth);
  upsertContactContextProjection(database, profile.contactId, "crm.priority", profile.priority);
  upsertContactContextProjection(
    database,
    profile.contactId,
    "crm.owner",
    profile.ownerType && profile.ownerId ? { type: profile.ownerType, id: profile.ownerId } : null,
  );
  upsertContactContextProjection(
    database,
    profile.contactId,
    "crm.primary_account",
    profile.primaryAccountId ? { id: profile.primaryAccountId } : null,
  );
  upsertContactContextProjection(
    database,
    profile.contactId,
    "crm.primary_opportunity",
    profile.primaryOpportunityId ? { id: profile.primaryOpportunityId } : null,
  );
  upsertContactContextProjection(
    database,
    profile.contactId,
    "crm.next_action",
    profile.nextTaskId || profile.nextActionAt || profile.nextActionSummary
      ? {
          taskId: profile.nextTaskId,
          at: profile.nextActionAt,
          summary: profile.nextActionSummary,
        }
      : null,
  );
}

function profileEventPayload(profile: CrmContactProfile): Record<string, unknown> {
  return {
    contactId: profile.contactId,
    lifecycle: profile.lifecycle,
    relationshipHealth: profile.relationshipHealth,
    priority: profile.priority,
    score: profile.score,
    healthScore: profile.healthScore,
    ownerType: profile.ownerType,
    ownerId: profile.ownerId,
    primaryAccountId: profile.primaryAccountId,
    primaryOpportunityId: profile.primaryOpportunityId,
    leadSource: profile.leadSource,
    persona: profile.persona,
    buyingRole: profile.buyingRole,
    lastMeaningfulInteractionAt: profile.lastMeaningfulInteractionAt,
    nextActionAt: profile.nextActionAt,
    nextActionSummary: profile.nextActionSummary,
    nextTaskId: profile.nextTaskId,
    metadata: profile.metadata,
  };
}

export function updateCrmContactProfile(input: UpdateCrmContactProfileInput): CrmContactProfile {
  const database = ensureDb();
  const contactId = resolveRequiredCanonicalContactId(database, input.contactRef);
  if (input.primaryAccountId) requireCrmAccount(database, input.primaryAccountId);
  if (input.primaryOpportunityId) requireCrmOpportunity(database, input.primaryOpportunityId);
  if (input.nextTaskId) requireCrmTask(database, input.nextTaskId);

  let profile: CrmContactProfile | null = null;
  const txn = database.transaction(() => {
    const previousRow = getCrmContactProfileRow(database, contactId);
    const previous = previousRow ? rowToCrmContactProfile(previousRow) : null;
    const owner = normalizeOptionalCrmOwner({
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      previousOwnerType: previous?.ownerType ?? null,
      previousOwnerId: previous?.ownerId ?? null,
    });
    const lifecycle =
      input.lifecycle === null
        ? "unknown"
        : normalizeCrmEnum<CrmContactLifecycle>(
            input.lifecycle,
            CRM_CONTACT_LIFECYCLES,
            previous?.lifecycle ?? "unknown",
          );
    const relationshipHealth =
      input.relationshipHealth === null
        ? "unknown"
        : normalizeCrmEnum<CrmRelationshipHealth>(
            input.relationshipHealth,
            CRM_RELATIONSHIP_HEALTHS,
            previous?.relationshipHealth ?? "unknown",
          );
    const priority =
      input.priority === null
        ? "normal"
        : normalizeCrmEnum<CrmPriority>(input.priority, CRM_PRIORITIES, previous?.priority ?? "normal");
    const metadata = normalizeMetadataObject(input.metadata, previousRow?.metadata_json ?? "{}");

    database
      .prepare(
        `
        INSERT INTO crm_contact_profiles (
          contact_id, lifecycle, relationship_health, priority, score, health_score,
          owner_type, owner_id, primary_account_id, primary_opportunity_id,
          lead_source, persona, buying_role, last_meaningful_interaction_at,
          next_action_at, next_action_summary, next_task_id, metadata_json,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(contact_id) DO UPDATE SET
          lifecycle = excluded.lifecycle,
          relationship_health = excluded.relationship_health,
          priority = excluded.priority,
          score = excluded.score,
          health_score = excluded.health_score,
          owner_type = excluded.owner_type,
          owner_id = excluded.owner_id,
          primary_account_id = excluded.primary_account_id,
          primary_opportunity_id = excluded.primary_opportunity_id,
          lead_source = excluded.lead_source,
          persona = excluded.persona,
          buying_role = excluded.buying_role,
          last_meaningful_interaction_at = excluded.last_meaningful_interaction_at,
          next_action_at = excluded.next_action_at,
          next_action_summary = excluded.next_action_summary,
          next_task_id = excluded.next_task_id,
          metadata_json = excluded.metadata_json,
          updated_at = datetime('now')
      `,
      )
      .run(
        contactId,
        lifecycle,
        relationshipHealth,
        priority,
        normalizeOptionalNumber(input.score, "score", previous?.score ?? null),
        normalizeOptionalNumber(input.healthScore, "health_score", previous?.healthScore ?? null),
        owner.ownerType,
        owner.ownerId,
        input.primaryAccountId === undefined
          ? (previous?.primaryAccountId ?? null)
          : normalizeOptionalText(input.primaryAccountId),
        input.primaryOpportunityId === undefined
          ? (previous?.primaryOpportunityId ?? null)
          : normalizeOptionalText(input.primaryOpportunityId),
        normalizeOptionalText(input.leadSource, previous?.leadSource ?? null),
        normalizeOptionalText(input.persona, previous?.persona ?? null),
        normalizeOptionalText(input.buyingRole, previous?.buyingRole ?? null),
        normalizeOptionalText(input.lastMeaningfulInteractionAt, previous?.lastMeaningfulInteractionAt ?? null),
        normalizeOptionalText(input.nextActionAt, previous?.nextActionAt ?? null),
        normalizeOptionalText(input.nextActionSummary, previous?.nextActionSummary ?? null),
        input.nextTaskId === undefined ? (previous?.nextTaskId ?? null) : normalizeOptionalText(input.nextTaskId),
        jsonObject(metadata),
      );

    const nextRow = getCrmContactProfileRow(database, contactId);
    if (!nextRow) throw new Error(`CRM contact profile not found after update: ${contactId}`);
    profile = rowToCrmContactProfile(nextRow);
    projectCrmContactProfileMetadata(database, profile);
    insertCrmEvent(database, {
      eventType: "crm.contact_profile.updated",
      entityType: "contact",
      entityId: contactId,
      contactId,
      source: crmMutationSource(input),
      actorType: input.actorType,
      actorId: input.actorId,
      confidence: input.confidence,
      evidence: input.evidence,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      payload: profileEventPayload(profile),
      previousPayload: previous ? profileEventPayload(previous) : null,
    });
  });
  txn();
  if (!profile) throw new Error(`CRM contact profile not updated: ${contactId}`);
  return profile;
}

export function getCrmContactProfile(contactRef: string): CrmContactProfileCard | null {
  const database = ensureDb();
  const contactId = resolveCanonicalContactId(database, contactRef);
  if (!contactId) return null;
  const details = getContactDetailsByCanonicalId(database, contactId, { includeDuplicateCandidates: false });
  if (!details) return null;
  const profileRow = getCrmContactProfileRow(database, contactId);
  const profile = profileRow ? rowToCrmContactProfile(profileRow) : null;
  const cardRow = database.prepare("SELECT * FROM crm_contact_cards WHERE contact_id = ?").get(contactId) as
    | CrmContactCardRow
    | undefined;
  const accountMembershipRows = database
    .prepare("SELECT * FROM crm_account_contacts WHERE contact_id = ? ORDER BY is_primary DESC, updated_at DESC")
    .all(contactId) as CrmAccountContactRow[];
  const opportunities = database
    .prepare(
      `
      SELECT DISTINCT o.*
      FROM crm_opportunities o
      LEFT JOIN crm_opportunity_contacts oc ON oc.opportunity_id = o.id AND oc.contact_id = ?
      WHERE o.archived_at IS NULL
        AND (o.primary_contact_id = ? OR oc.contact_id IS NOT NULL)
      ORDER BY o.updated_at DESC
    `,
    )
    .all(contactId, contactId) as CrmOpportunityRow[];
  const tasks = database
    .prepare("SELECT * FROM crm_tasks WHERE contact_id = ? ORDER BY created_at DESC, id DESC LIMIT 50")
    .all(contactId) as CrmTaskRow[];
  return {
    contact: details.contact,
    policy: details.policy,
    profile,
    card: cardRow ? rowToCrmContactCard(cardRow) : null,
    accountMemberships: accountMembershipRows.map((membership) => {
      const account = getCrmAccountRow(database, membership.account_id);
      return { ...rowToCrmAccountContact(membership), account: account ? rowToCrmAccount(account) : null };
    }),
    opportunities: opportunities.map(rowToCrmOpportunity),
    tasks: tasks.map(rowToCrmTask),
    nextActions: listCrmNextActions({ contactRef: contactId, limit: 20 }).items,
    facts: listCrmFacts({ contactRef: contactId, limit: 20 }).items,
  };
}

export function listCrmContactCards(options: ListCrmContactCardsOptions = {}): ListPage<CrmContactCard> {
  const database = ensureDb();
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (options.lifecycle?.trim()) {
    where.push("COALESCE(lifecycle, 'unknown') = ?");
    params.push(normalizeCrmEnum<CrmContactLifecycle>(options.lifecycle, CRM_CONTACT_LIFECYCLES, "unknown"));
  }
  if (options.ownerType || options.ownerId) {
    const owner = normalizeOptionalCrmOwner({ ownerType: options.ownerType, ownerId: options.ownerId });
    where.push("owner_type = ?", "owner_id = ?");
    params.push(owner.ownerType!, owner.ownerId!);
  }
  const { limit, offset } = normalizeLimitOffsetPage(options, { defaultLimit: 50, maxLimit: 500 });
  const total = countRows({ db: database, table: "crm_contact_cards", where, params });
  const rows = database
    .prepare(
      `
      SELECT * FROM crm_contact_cards
      ${buildSqlWhereClause(where)}
      ORDER BY COALESCE(next_action_at, updated_at) DESC, display_name, contact_id
      LIMIT ? OFFSET ?
    `,
    )
    .all(...params, limit, offset) as CrmContactCardRow[];
  return { total, limit, offset, items: rows.map(rowToCrmContactCard) };
}

export function createCrmAccount(input: CreateCrmAccountInput): CrmAccount {
  const database = ensureDb();
  const name = normalizeRequiredText(input.name, "CRM account name");
  const orgContactId = input.orgContactRef
    ? resolveRequiredCanonicalContactId(database, input.orgContactRef, "Organization contact")
    : null;
  if (orgContactId) {
    const org = getCanonicalContactById(database, orgContactId);
    if (org?.kind !== "org") throw new Error(`CRM account org contact must have kind='org': ${orgContactId}`);
  }
  const owner = normalizeOptionalCrmOwner({ ownerType: input.ownerType, ownerId: input.ownerId });
  const idempotencyKey = normalizeCrmIdempotencyKey(input.idempotencyKey);
  if (idempotencyKey) {
    const existingRow = database.prepare("SELECT * FROM crm_accounts WHERE idempotency_key = ?").get(idempotencyKey) as
      | CrmAccountRow
      | undefined;
    if (existingRow) return rowToCrmAccount(existingRow);
    const existingEvent = getCrmEventRowByIdempotencyKey(database, idempotencyKey);
    if (existingEvent?.entity_type === "account") {
      const row = getCrmAccountRow(database, existingEvent.entity_id);
      if (row) return rowToCrmAccount(row);
    }
  }
  const accountId = `crm_acc_${generateId()}`;
  let account: CrmAccount | null = null;
  const txn = database.transaction(() => {
    database
      .prepare(
        `
        INSERT INTO crm_accounts (
          id, org_contact_id, name, legal_name, domain, website_url, industry, size_label,
          lifecycle, relationship_health, priority, owner_type, owner_id,
          source, idempotency_key, confidence, metadata_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `,
      )
      .run(
        accountId,
        orgContactId,
        name,
        normalizeOptionalText(input.legalName),
        normalizeOptionalText(input.domain)?.toLowerCase() ?? null,
        normalizeOptionalText(input.websiteUrl),
        normalizeOptionalText(input.industry),
        normalizeOptionalText(input.sizeLabel),
        normalizeCrmEnum<CrmContactLifecycle>(input.lifecycle, CRM_CONTACT_LIFECYCLES, "unknown"),
        normalizeCrmEnum<CrmRelationshipHealth>(input.relationshipHealth, CRM_RELATIONSHIP_HEALTHS, "unknown"),
        normalizeCrmEnum<CrmPriority>(input.priority, CRM_PRIORITIES, "normal"),
        owner.ownerType,
        owner.ownerId,
        crmMutationSource(input),
        idempotencyKey,
        normalizeCrmConfidence(input.confidence),
        jsonObject(input.metadata),
      );
    const row = getCrmAccountRow(database, accountId);
    if (!row) throw new Error(`CRM account not found after create: ${accountId}`);
    account = rowToCrmAccount(row);
    insertCrmEvent(database, {
      eventType: "crm.account.created",
      entityType: "account",
      entityId: accountId,
      accountId,
      contactId: orgContactId,
      source: account.source,
      idempotencyKey,
      actorType: input.actorType,
      actorId: input.actorId,
      confidence: account.confidence,
      evidence: input.evidence,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      payload: account,
    });
  });
  txn();
  if (!account) throw new Error(`CRM account not created: ${accountId}`);
  return account;
}

function refreshCrmContactPrimaryAccount(
  database: Database,
  contactId: string,
  preferredAccountId?: string | null,
): void {
  let nextAccountId: string | null = null;
  if (preferredAccountId) {
    const preferred = database
      .prepare(
        `
        SELECT account_id FROM crm_account_contacts
        WHERE contact_id = ? AND account_id = ? AND is_primary = 1
        ORDER BY updated_at DESC, account_id
        LIMIT 1
      `,
      )
      .get(contactId, preferredAccountId) as { account_id: string } | undefined;
    nextAccountId = preferred?.account_id ?? null;
  }
  if (!nextAccountId) {
    const fallback = database
      .prepare(
        `
        SELECT account_id FROM crm_account_contacts
        WHERE contact_id = ? AND is_primary = 1
        ORDER BY updated_at DESC, account_id
        LIMIT 1
      `,
      )
      .get(contactId) as { account_id: string } | undefined;
    nextAccountId = fallback?.account_id ?? null;
  }

  if (nextAccountId) {
    database
      .prepare(
        `
        INSERT INTO crm_contact_profiles (contact_id, primary_account_id, created_at, updated_at)
        VALUES (?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(contact_id) DO UPDATE SET
          primary_account_id = excluded.primary_account_id,
          updated_at = datetime('now')
      `,
      )
      .run(contactId, nextAccountId);
  } else {
    database
      .prepare(
        `
        UPDATE crm_contact_profiles
        SET primary_account_id = NULL, updated_at = datetime('now')
        WHERE contact_id = ? AND primary_account_id IS NOT NULL
      `,
      )
      .run(contactId);
  }

  const profileRow = getCrmContactProfileRow(database, contactId);
  if (profileRow) projectCrmContactProfileMetadata(database, rowToCrmContactProfile(profileRow));
}

export function getCrmAccount(accountRef: string): CrmAccountDetail | null {
  const database = ensureDb();
  const accountRow = getCrmAccountRow(database, accountRef);
  if (!accountRow) return null;
  const contacts = database
    .prepare("SELECT * FROM crm_account_contacts WHERE account_id = ? ORDER BY is_primary DESC, updated_at DESC")
    .all(accountRow.id) as CrmAccountContactRow[];
  const opportunities = database
    .prepare("SELECT * FROM crm_opportunities WHERE account_id = ? ORDER BY updated_at DESC")
    .all(accountRow.id) as CrmOpportunityRow[];
  const tasks = database
    .prepare("SELECT * FROM crm_tasks WHERE account_id = ? ORDER BY created_at DESC, id DESC LIMIT 50")
    .all(accountRow.id) as CrmTaskRow[];
  return {
    account: rowToCrmAccount(accountRow),
    contacts: contacts.map((membership) => ({
      ...rowToCrmAccountContact(membership),
      contact: getCanonicalContactById(database, membership.contact_id),
    })),
    opportunities: opportunities.map(rowToCrmOpportunity),
    tasks: tasks.map(rowToCrmTask),
  };
}

export function linkCrmAccountContact(input: LinkCrmAccountContactInput): CrmAccountContact {
  const database = ensureDb();
  const account = requireCrmAccount(database, input.accountId);
  const contactId = resolveRequiredCanonicalContactId(database, input.contactRef);
  const contact = getCanonicalContactById(database, contactId);
  if (contact?.kind === "org") throw new Error("CRM account memberships require a person contact");
  const role = normalizeOptionalText(input.role) ?? "member";
  const id = stableId("crm_ac", [account.id, contactId, role]);
  let membership: CrmAccountContact | null = null;
  const txn = database.transaction(() => {
    const previous = database.prepare("SELECT * FROM crm_account_contacts WHERE id = ?").get(id) as
      | CrmAccountContactRow
      | undefined;
    const affectedContactIds = new Set<string>([contactId]);
    if (input.isPrimary) {
      const previousPrimaryRows = database
        .prepare("SELECT DISTINCT contact_id FROM crm_account_contacts WHERE account_id = ? AND is_primary = 1")
        .all(account.id) as Array<{ contact_id: string }>;
      for (const row of previousPrimaryRows) affectedContactIds.add(row.contact_id);
      database.prepare("UPDATE crm_account_contacts SET is_primary = 0 WHERE account_id = ?").run(account.id);
    } else if (input.isPrimary === false && previous?.is_primary) {
      affectedContactIds.add(previous.contact_id);
    }
    const nextIsPrimary = input.isPrimary === undefined ? (previous?.is_primary ?? 0) : input.isPrimary ? 1 : 0;
    database
      .prepare(
        `
        INSERT INTO crm_account_contacts (
          id, account_id, contact_id, role, title, department, decision_role,
          relationship_strength, is_primary, status, source, confidence,
          evidence_json, metadata_json, first_seen_at, last_seen_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now'), datetime('now'))
        ON CONFLICT(account_id, contact_id, role) DO UPDATE SET
          title = excluded.title,
          department = excluded.department,
          decision_role = excluded.decision_role,
          relationship_strength = excluded.relationship_strength,
          is_primary = excluded.is_primary,
          status = excluded.status,
          source = excluded.source,
          confidence = excluded.confidence,
          evidence_json = excluded.evidence_json,
          metadata_json = excluded.metadata_json,
          last_seen_at = datetime('now'),
          updated_at = datetime('now')
      `,
      )
      .run(
        id,
        account.id,
        contactId,
        role,
        normalizeOptionalText(input.title, previous?.title ?? null),
        normalizeOptionalText(input.department, previous?.department ?? null),
        normalizeOptionalText(input.decisionRole, previous?.decision_role ?? "unknown") ?? "unknown",
        normalizeOptionalText(input.relationshipStrength, previous?.relationship_strength ?? "unknown") ?? "unknown",
        nextIsPrimary,
        normalizeOptionalText(input.status, previous?.status ?? "active") ?? "active",
        crmMutationSource(input),
        normalizeCrmConfidence(input.confidence),
        crmEventJson(input.evidence),
        jsonObject(normalizeMetadataObject(input.metadata, previous?.metadata_json ?? "{}")),
      );
    const row = database.prepare("SELECT * FROM crm_account_contacts WHERE id = ?").get(id) as
      | CrmAccountContactRow
      | undefined;
    if (!row) throw new Error(`CRM account membership not found after link: ${id}`);
    const linkedMembership = rowToCrmAccountContact(row);
    membership = linkedMembership;
    for (const affectedContactId of affectedContactIds) {
      refreshCrmContactPrimaryAccount(
        database,
        affectedContactId,
        affectedContactId === contactId && linkedMembership.isPrimary ? account.id : null,
      );
    }
    insertCrmEvent(database, {
      eventType: "crm.account_contact.linked",
      entityType: "account",
      entityId: account.id,
      contactId,
      accountId: account.id,
      source: linkedMembership.source,
      actorType: input.actorType,
      actorId: input.actorId,
      confidence: linkedMembership.confidence,
      evidence: input.evidence,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      payload: linkedMembership,
      previousPayload: previous ? rowToCrmAccountContact(previous) : null,
    });
  });
  txn();
  if (!membership) throw new Error(`CRM account membership not linked: ${id}`);
  return membership;
}

function resolveCrmStage(database: Database, stageRef?: string | null, pipelineId?: string | null): CrmPipelineStage {
  const resolvedPipelineId = pipelineId?.trim() || "crm_pipeline_default";
  const ref = stageRef?.trim();
  const row = ref
    ? (database
        .prepare(
          `
          SELECT * FROM crm_pipeline_stages
          WHERE pipeline_id = ? AND (id = ? OR key = ?)
          LIMIT 1
        `,
        )
        .get(resolvedPipelineId, ref, ref) as CrmPipelineStageRow | undefined)
    : (database
        .prepare("SELECT * FROM crm_pipeline_stages WHERE pipeline_id = ? ORDER BY sort_order LIMIT 1")
        .get(resolvedPipelineId) as CrmPipelineStageRow | undefined);
  if (!row) throw new Error(`CRM pipeline stage not found: ${ref ?? "default"}`);
  return rowToCrmPipelineStage(row);
}

function opportunityStatusForStage(stage: CrmPipelineStage, fallback: CrmOpportunityStatus): CrmOpportunityStatus {
  if (stage.category === "terminal_won") return "won";
  if (stage.category === "terminal_lost") return "lost";
  if (fallback === "won" || fallback === "lost") return "open";
  return fallback;
}

export function createCrmOpportunity(input: CreateCrmOpportunityInput): CrmOpportunity {
  const database = ensureDb();
  const title = normalizeRequiredText(input.title, "CRM opportunity title");
  const accountId = normalizeOptionalText(input.accountId);
  const contactId = input.contactRef ? resolveRequiredCanonicalContactId(database, input.contactRef) : null;
  if (!accountId && !contactId) throw new Error("CRM opportunity requires an account or contact target");
  if (accountId) requireCrmAccount(database, accountId);
  const stage = resolveCrmStage(database, input.stageId ?? input.stageKey, input.pipelineId);
  const owner = normalizeOptionalCrmOwner({ ownerType: input.ownerType, ownerId: input.ownerId });
  const idempotencyKey = normalizeCrmIdempotencyKey(input.idempotencyKey);
  if (idempotencyKey) {
    const existingRow = database
      .prepare("SELECT * FROM crm_opportunities WHERE idempotency_key = ?")
      .get(idempotencyKey) as CrmOpportunityRow | undefined;
    if (existingRow) return rowToCrmOpportunity(existingRow);
    const existingEvent = getCrmEventRowByIdempotencyKey(database, idempotencyKey);
    if (existingEvent?.entity_type === "opportunity") {
      const row = getCrmOpportunityRow(database, existingEvent.entity_id);
      if (row) return rowToCrmOpportunity(row);
    }
  }
  const opportunityId = `crm_opp_${generateId()}`;
  let opportunity: CrmOpportunity | null = null;
  const txn = database.transaction(() => {
    database
      .prepare(
        `
        INSERT INTO crm_opportunities (
          id, account_id, primary_contact_id, pipeline_id, stage_id, title, description,
          status, priority, value_cents, currency, probability, expected_close_at,
          owner_type, owner_id, source, idempotency_key, confidence, evidence_json, metadata_json,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `,
      )
      .run(
        opportunityId,
        accountId,
        contactId,
        stage.pipelineId,
        stage.id,
        title,
        normalizeOptionalText(input.description),
        normalizeCrmEnum<CrmOpportunityStatus>(
          input.status,
          CRM_OPPORTUNITY_STATUSES,
          opportunityStatusForStage(stage, "open"),
        ),
        normalizeCrmEnum<CrmPriority>(input.priority, CRM_PRIORITIES, "normal"),
        input.valueCents ?? null,
        normalizeOptionalText(input.currency) ?? "BRL",
        normalizeProbability(input.probability, stage.probability),
        normalizeOptionalText(input.expectedCloseAt),
        owner.ownerType,
        owner.ownerId,
        crmMutationSource(input),
        idempotencyKey,
        normalizeCrmConfidence(input.confidence),
        crmEventJson(input.evidence),
        jsonObject(input.metadata),
      );
    const row = requireCrmOpportunity(database, opportunityId);
    opportunity = rowToCrmOpportunity(row);
    if (contactId) {
      database
        .prepare(
          `
          INSERT OR IGNORE INTO crm_opportunity_contacts (
            id, opportunity_id, contact_id, account_id, role, is_primary,
            source, confidence, evidence_json, metadata_json, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, 'stakeholder', 1, ?, ?, ?, '{}', datetime('now'), datetime('now'))
        `,
        )
        .run(
          stableId("crm_oc", [opportunityId, contactId, "stakeholder"]),
          opportunityId,
          contactId,
          accountId,
          opportunity.source,
          opportunity.confidence,
          crmEventJson(input.evidence),
        );
      database
        .prepare(
          `
          INSERT INTO crm_contact_profiles (contact_id, primary_opportunity_id, created_at, updated_at)
          VALUES (?, ?, datetime('now'), datetime('now'))
          ON CONFLICT(contact_id) DO UPDATE SET primary_opportunity_id = COALESCE(primary_opportunity_id, excluded.primary_opportunity_id), updated_at = datetime('now')
        `,
        )
        .run(contactId, opportunityId);
      const profileRow = getCrmContactProfileRow(database, contactId);
      if (profileRow) projectCrmContactProfileMetadata(database, rowToCrmContactProfile(profileRow));
    }
    insertCrmEvent(database, {
      eventType: "crm.opportunity.created",
      entityType: "opportunity",
      entityId: opportunityId,
      contactId,
      accountId,
      opportunityId,
      source: opportunity.source,
      idempotencyKey,
      actorType: input.actorType,
      actorId: input.actorId,
      confidence: opportunity.confidence,
      evidence: input.evidence,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      payload: opportunity,
    });
  });
  txn();
  if (!opportunity) throw new Error(`CRM opportunity not created: ${opportunityId}`);
  return opportunity;
}

function refreshCrmContactPrimaryOpportunity(
  database: Database,
  contactId: string,
  preferredOpportunityId?: string | null,
): void {
  let nextOpportunityId: string | null = null;
  if (preferredOpportunityId) {
    const preferred = database
      .prepare(
        `
        SELECT opportunity_id FROM crm_opportunity_contacts
        WHERE contact_id = ? AND opportunity_id = ? AND is_primary = 1
        ORDER BY updated_at DESC, opportunity_id
        LIMIT 1
      `,
      )
      .get(contactId, preferredOpportunityId) as { opportunity_id: string } | undefined;
    nextOpportunityId = preferred?.opportunity_id ?? null;
  }
  if (!nextOpportunityId) {
    const fallback = database
      .prepare(
        `
        SELECT opportunity_id FROM crm_opportunity_contacts
        WHERE contact_id = ? AND is_primary = 1
        ORDER BY updated_at DESC, opportunity_id
        LIMIT 1
      `,
      )
      .get(contactId) as { opportunity_id: string } | undefined;
    nextOpportunityId = fallback?.opportunity_id ?? null;
  }

  if (nextOpportunityId) {
    database
      .prepare(
        `
        INSERT INTO crm_contact_profiles (contact_id, primary_opportunity_id, created_at, updated_at)
        VALUES (?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(contact_id) DO UPDATE SET
          primary_opportunity_id = excluded.primary_opportunity_id,
          updated_at = datetime('now')
      `,
      )
      .run(contactId, nextOpportunityId);
  } else {
    database
      .prepare(
        `
        UPDATE crm_contact_profiles
        SET primary_opportunity_id = NULL, updated_at = datetime('now')
        WHERE contact_id = ? AND primary_opportunity_id IS NOT NULL
      `,
      )
      .run(contactId);
  }

  const profileRow = getCrmContactProfileRow(database, contactId);
  if (profileRow) projectCrmContactProfileMetadata(database, rowToCrmContactProfile(profileRow));
}

function refreshCrmOpportunityPrimaryContact(
  database: Database,
  opportunityId: string,
  preferredContactId?: string | null,
): string | null {
  let nextContactId: string | null = null;
  if (preferredContactId) {
    const preferred = database
      .prepare(
        `
        SELECT contact_id FROM crm_opportunity_contacts
        WHERE opportunity_id = ? AND contact_id = ? AND is_primary = 1
        ORDER BY updated_at DESC, contact_id
        LIMIT 1
      `,
      )
      .get(opportunityId, preferredContactId) as { contact_id: string } | undefined;
    nextContactId = preferred?.contact_id ?? null;
  }
  if (!nextContactId) {
    const fallback = database
      .prepare(
        `
        SELECT contact_id FROM crm_opportunity_contacts
        WHERE opportunity_id = ? AND is_primary = 1
        ORDER BY updated_at DESC, contact_id
        LIMIT 1
      `,
      )
      .get(opportunityId) as { contact_id: string } | undefined;
    nextContactId = fallback?.contact_id ?? null;
  }
  database
    .prepare("UPDATE crm_opportunities SET primary_contact_id = ?, updated_at = datetime('now') WHERE id = ?")
    .run(nextContactId, opportunityId);
  return nextContactId;
}

export function linkCrmOpportunityContact(input: LinkCrmOpportunityContactInput): CrmOpportunityContact {
  const database = ensureDb();
  const opportunity = requireCrmOpportunity(database, input.opportunityId);
  const contactId = resolveRequiredCanonicalContactId(database, input.contactRef);
  const accountId = normalizeOptionalText(input.accountId) ?? opportunity.account_id;
  if (accountId) requireCrmAccount(database, accountId);
  const role = normalizeOptionalText(input.role) ?? "stakeholder";
  const id = stableId("crm_oc", [opportunity.id, contactId, role]);
  let link: CrmOpportunityContact | null = null;
  const txn = database.transaction(() => {
    const previous = database.prepare("SELECT * FROM crm_opportunity_contacts WHERE id = ?").get(id) as
      | CrmOpportunityContactRow
      | undefined;
    const affectedContactIds = new Set<string>([contactId]);
    if (input.isPrimary) {
      const previousPrimaryRows = database
        .prepare("SELECT DISTINCT contact_id FROM crm_opportunity_contacts WHERE opportunity_id = ? AND is_primary = 1")
        .all(opportunity.id) as Array<{ contact_id: string }>;
      for (const row of previousPrimaryRows) affectedContactIds.add(row.contact_id);
      database
        .prepare("UPDATE crm_opportunity_contacts SET is_primary = 0 WHERE opportunity_id = ?")
        .run(opportunity.id);
    } else if (input.isPrimary === false && previous?.is_primary) {
      affectedContactIds.add(previous.contact_id);
    }
    const nextIsPrimary = input.isPrimary === undefined ? (previous?.is_primary ?? 0) : input.isPrimary ? 1 : 0;
    database
      .prepare(
        `
        INSERT INTO crm_opportunity_contacts (
          id, opportunity_id, contact_id, account_id, role, influence, sentiment, is_primary,
          source, confidence, evidence_json, metadata_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(opportunity_id, contact_id, role) DO UPDATE SET
          account_id = excluded.account_id,
          influence = excluded.influence,
          sentiment = excluded.sentiment,
          is_primary = excluded.is_primary,
          source = excluded.source,
          confidence = excluded.confidence,
          evidence_json = excluded.evidence_json,
          metadata_json = excluded.metadata_json,
          updated_at = datetime('now')
      `,
      )
      .run(
        id,
        opportunity.id,
        contactId,
        accountId,
        role,
        normalizeOptionalText(input.influence, previous?.influence ?? "unknown") ?? "unknown",
        normalizeOptionalText(input.sentiment, previous?.sentiment ?? "unknown") ?? "unknown",
        nextIsPrimary,
        crmMutationSource(input),
        normalizeCrmConfidence(input.confidence),
        crmEventJson(input.evidence),
        jsonObject(normalizeMetadataObject(input.metadata, previous?.metadata_json ?? "{}")),
      );
    if (nextIsPrimary === 1) {
      refreshCrmOpportunityPrimaryContact(database, opportunity.id, contactId);
    } else if (previous?.is_primary) {
      const fallbackContactId = refreshCrmOpportunityPrimaryContact(database, opportunity.id);
      if (fallbackContactId) affectedContactIds.add(fallbackContactId);
    }
    for (const affectedContactId of affectedContactIds) {
      refreshCrmContactPrimaryOpportunity(
        database,
        affectedContactId,
        affectedContactId === contactId && nextIsPrimary === 1 ? opportunity.id : null,
      );
    }
    const row = database.prepare("SELECT * FROM crm_opportunity_contacts WHERE id = ?").get(id) as
      | CrmOpportunityContactRow
      | undefined;
    if (!row) throw new Error(`CRM opportunity contact not found after link: ${id}`);
    link = rowToCrmOpportunityContact(row);
    insertCrmEvent(database, {
      eventType: "crm.opportunity_contact.linked",
      entityType: "opportunity",
      entityId: opportunity.id,
      contactId,
      accountId,
      opportunityId: opportunity.id,
      source: link.source,
      actorType: input.actorType,
      actorId: input.actorId,
      confidence: link.confidence,
      evidence: input.evidence,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      payload: link,
      previousPayload: previous ? rowToCrmOpportunityContact(previous) : null,
    });
  });
  txn();
  if (!link) throw new Error(`CRM opportunity contact not linked: ${id}`);
  return link;
}

export function listCrmOpportunityContacts(opportunityId: string): CrmOpportunityContact[] {
  const database = ensureDb();
  requireCrmOpportunity(database, opportunityId);
  const rows = database
    .prepare(
      "SELECT * FROM crm_opportunity_contacts WHERE opportunity_id = ? ORDER BY is_primary DESC, updated_at DESC",
    )
    .all(opportunityId) as CrmOpportunityContactRow[];
  return rows.map(rowToCrmOpportunityContact);
}

export function moveCrmOpportunityStage(input: MoveCrmOpportunityStageInput): CrmOpportunity {
  const database = ensureDb();
  const previous = requireCrmOpportunity(database, input.opportunityId);
  const stage = resolveCrmStage(database, input.stageRef, previous.pipeline_id ?? "crm_pipeline_default");
  const nextStatus = opportunityStatusForStage(stage, previous.status);
  let opportunity: CrmOpportunity | null = null;
  const txn = database.transaction(() => {
    database
      .prepare(
        `
        UPDATE crm_opportunities
        SET pipeline_id = ?, stage_id = ?, status = ?, closed_at = ?, lost_reason = ?, updated_at = datetime('now')
        WHERE id = ?
      `,
      )
      .run(
        stage.pipelineId,
        stage.id,
        nextStatus,
        nextStatus === "won" || nextStatus === "lost" ? new Date().toISOString() : null,
        nextStatus === "lost" ? (normalizeOptionalText(input.lostReason) ?? previous.lost_reason) : null,
        previous.id,
      );
    const next = requireCrmOpportunity(database, previous.id);
    opportunity = rowToCrmOpportunity(next);
    insertCrmEvent(database, {
      eventType: "crm.opportunity.stage_changed",
      entityType: "opportunity",
      entityId: previous.id,
      contactId: previous.primary_contact_id,
      accountId: previous.account_id,
      opportunityId: previous.id,
      source: crmMutationSource(input),
      actorType: input.actorType,
      actorId: input.actorId,
      confidence: input.confidence,
      evidence: input.evidence,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      payload: { opportunity, stage },
      previousPayload: { opportunity: rowToCrmOpportunity(previous), stageId: previous.stage_id },
    });
    if (previous.status !== next.status) {
      insertCrmEvent(database, {
        eventType: "crm.opportunity.status_changed",
        entityType: "opportunity",
        entityId: previous.id,
        contactId: previous.primary_contact_id,
        accountId: previous.account_id,
        opportunityId: previous.id,
        source: crmMutationSource(input),
        actorType: input.actorType,
        actorId: input.actorId,
        confidence: input.confidence,
        evidence: input.evidence,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        payload: { status: next.status, closedAt: next.closed_at, lostReason: next.lost_reason },
        previousPayload: { status: previous.status, closedAt: previous.closed_at, lostReason: previous.lost_reason },
      });
    }
  });
  txn();
  if (!opportunity) throw new Error(`CRM opportunity not moved: ${input.opportunityId}`);
  return opportunity;
}

export function getCrmOpportunity(opportunityId: string): CrmOpportunity | null {
  const row = getCrmOpportunityRow(ensureDb(), opportunityId);
  return row ? rowToCrmOpportunity(row) : null;
}

export function listCrmOpportunityBoard(): CrmOpportunityBoardCard[] {
  const rows = ensureDb().prepare("SELECT * FROM crm_opportunity_board").all() as CrmOpportunityBoardRow[];
  return rows.map(rowToCrmOpportunityBoardCard);
}

function refreshCrmContactNextAction(database: Database, contactId: string): void {
  const next = database
    .prepare(
      `
      SELECT * FROM crm_next_actions
      WHERE contact_id = ?
      ORDER BY
        CASE priority
          WHEN 'urgent' THEN 0
          WHEN 'high' THEN 1
          WHEN 'normal' THEN 2
          ELSE 3
        END,
        due_at IS NULL,
        due_at ASC,
        task_id ASC
      LIMIT 1
    `,
    )
    .get(contactId) as CrmNextActionRow | undefined;
  database
    .prepare(
      `
      INSERT INTO crm_contact_profiles (
        contact_id, next_action_at, next_action_summary, next_task_id, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(contact_id) DO UPDATE SET
        next_action_at = excluded.next_action_at,
        next_action_summary = excluded.next_action_summary,
        next_task_id = excluded.next_task_id,
        updated_at = datetime('now')
    `,
    )
    .run(contactId, next?.due_at ?? null, next?.title ?? null, next?.task_id ?? null);
  const profileRow = getCrmContactProfileRow(database, contactId);
  if (profileRow) projectCrmContactProfileMetadata(database, rowToCrmContactProfile(profileRow));
}

export function createCrmTask(input: CreateCrmTaskInput): CrmTask {
  const database = ensureDb();
  const title = normalizeRequiredText(input.title, "CRM task title");
  const opportunity = input.opportunityId ? requireCrmOpportunity(database, input.opportunityId) : null;
  const contactId = input.contactRef
    ? resolveRequiredCanonicalContactId(database, input.contactRef)
    : (opportunity?.primary_contact_id ?? null);
  const accountId = normalizeOptionalText(input.accountId) ?? opportunity?.account_id ?? null;
  if (accountId) requireCrmAccount(database, accountId);
  if (!contactId && !accountId && !input.opportunityId && !input.chatId && !input.sessionKey) {
    throw new Error("CRM task requires contact, account, opportunity, chat, or session target");
  }
  const owner = normalizeOptionalCrmOwner({ ownerType: input.ownerType, ownerId: input.ownerId });
  const idempotencyKey = normalizeCrmIdempotencyKey(input.idempotencyKey);
  if (idempotencyKey) {
    const existingRow = database.prepare("SELECT * FROM crm_tasks WHERE idempotency_key = ?").get(idempotencyKey) as
      | CrmTaskRow
      | undefined;
    if (existingRow) return rowToCrmTask(existingRow);
    const existingEvent = getCrmEventRowByIdempotencyKey(database, idempotencyKey);
    if (existingEvent?.entity_type === "task") {
      const row = getCrmTaskRow(database, existingEvent.entity_id);
      if (row) return rowToCrmTask(row);
    }
  }
  const taskId = `crm_task_${generateId()}`;
  let task: CrmTask | null = null;
  const txn = database.transaction(() => {
    database
      .prepare(
        `
        INSERT INTO crm_tasks (
          id, contact_id, account_id, opportunity_id, chat_id, session_key, title, body,
          task_type, status, priority, due_at, snoozed_until, owner_type, owner_id,
          created_by_type, created_by_id, source, idempotency_key, confidence, evidence_json, metadata_json,
          ravi_task_id, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `,
      )
      .run(
        taskId,
        contactId,
        accountId,
        input.opportunityId ?? null,
        normalizeOptionalText(input.chatId),
        normalizeOptionalText(input.sessionKey),
        title,
        normalizeOptionalText(input.body),
        normalizeOptionalText(input.taskType) ?? "follow_up",
        normalizeCrmEnum<CrmTaskStatus>(input.status, CRM_TASK_STATUSES, "open"),
        normalizeCrmEnum<CrmPriority>(input.priority, CRM_PRIORITIES, "normal"),
        normalizeOptionalText(input.dueAt),
        normalizeOptionalText(input.snoozedUntil),
        owner.ownerType,
        owner.ownerId,
        normalizeOptionalText(input.createdByType) ?? normalizeCrmActorType(input.actorType),
        normalizeOptionalText(input.createdById) ?? normalizeOptionalText(input.actorId),
        crmMutationSource(input),
        idempotencyKey,
        normalizeCrmConfidence(input.confidence),
        crmEventJson(input.evidence),
        jsonObject(input.metadata),
        normalizeOptionalText(input.raviTaskId),
      );
    const row = requireCrmTask(database, taskId);
    task = rowToCrmTask(row);
    if (contactId) refreshCrmContactNextAction(database, contactId);
    insertCrmEvent(database, {
      eventType: "crm.task.created",
      entityType: "task",
      entityId: taskId,
      contactId,
      accountId,
      opportunityId: input.opportunityId ?? null,
      taskId,
      source: task.source,
      idempotencyKey,
      actorType: input.actorType,
      actorId: input.actorId,
      confidence: task.confidence,
      evidence: input.evidence,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      payload: task,
    });
  });
  txn();
  if (!task) throw new Error(`CRM task not created: ${taskId}`);
  return task;
}

export function completeCrmTask(input: CompleteCrmTaskInput): CrmTask {
  const database = ensureDb();
  const previous = requireCrmTask(database, input.taskId);
  let task: CrmTask | null = rowToCrmTask(previous);
  if (previous.status === "done") return task;
  const txn = database.transaction(() => {
    database
      .prepare(
        `
        UPDATE crm_tasks
        SET status = 'done', completed_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
      `,
      )
      .run(previous.id);
    const row = requireCrmTask(database, previous.id);
    task = rowToCrmTask(row);
    if (row.contact_id) refreshCrmContactNextAction(database, row.contact_id);
    insertCrmEvent(database, {
      eventType: "crm.task.completed",
      entityType: "task",
      entityId: previous.id,
      contactId: previous.contact_id,
      accountId: previous.account_id,
      opportunityId: previous.opportunity_id,
      taskId: previous.id,
      source: crmMutationSource(input),
      actorType: input.actorType,
      actorId: input.actorId,
      confidence: input.confidence,
      evidence: input.evidence,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      payload: task,
      previousPayload: rowToCrmTask(previous),
    });
  });
  txn();
  if (!task) throw new Error(`CRM task not completed: ${input.taskId}`);
  return task;
}

export function getCrmTask(taskId: string): CrmTask | null {
  const row = getCrmTaskRow(ensureDb(), taskId);
  return row ? rowToCrmTask(row) : null;
}

export function listCrmNextActions(options: ListCrmNextActionsOptions = {}): ListPage<CrmNextAction> {
  const database = ensureDb();
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (options.contactRef?.trim()) {
    where.push("contact_id = ?");
    params.push(resolveRequiredCanonicalContactId(database, options.contactRef));
  }
  if (options.accountId?.trim()) {
    where.push("account_id = ?");
    params.push(options.accountId.trim());
  }
  if (options.opportunityId?.trim()) {
    where.push("opportunity_id = ?");
    params.push(options.opportunityId.trim());
  }
  if (options.ownerType || options.ownerId) {
    const owner = normalizeOptionalCrmOwner({ ownerType: options.ownerType, ownerId: options.ownerId });
    where.push("owner_type = ?", "owner_id = ?");
    params.push(owner.ownerType!, owner.ownerId!);
  }
  const { limit, offset } = normalizeLimitOffsetPage(options, { defaultLimit: 25, maxLimit: 500 });
  const total = countRows({ db: database, table: "crm_next_actions", where, params });
  const rows = database
    .prepare(
      `
      SELECT * FROM crm_next_actions
      ${buildSqlWhereClause(where)}
      ORDER BY
        CASE priority
          WHEN 'urgent' THEN 0
          WHEN 'high' THEN 1
          WHEN 'normal' THEN 2
          ELSE 3
        END,
        due_at IS NULL,
        due_at ASC,
        task_id ASC
      LIMIT ? OFFSET ?
    `,
    )
    .all(...params, limit, offset) as CrmNextActionRow[];
  return { total, limit, offset, items: rows.map(rowToCrmNextAction) };
}

function getCrmFactRow(database: Database, factId: string): CrmFactRow | null {
  const row = database.prepare("SELECT * FROM crm_facts WHERE id = ?").get(factId) as CrmFactRow | undefined;
  return row ?? null;
}

function requireCrmFact(database: Database, factId: string): CrmFactRow {
  const fact = getCrmFactRow(database, factId);
  if (!fact) throw new Error(`CRM fact not found: ${factId}`);
  return fact;
}

function resolveCrmFactTarget(
  database: Database,
  input: Pick<ProposeCrmFactInput, "entityType" | "entityId" | "contactRef" | "accountId" | "opportunityId">,
): {
  entityType: CrmEntityType;
  entityId: string;
  contactId: string | null;
  accountId: string | null;
  opportunityId: string | null;
} {
  const entityType = normalizeCrmEntityType(input.entityType);
  const rawEntityId = normalizeRequiredText(input.entityId, "CRM fact entity id");
  let entityId = rawEntityId;
  let contactId = input.contactRef ? resolveRequiredCanonicalContactId(database, input.contactRef) : null;
  let accountId = normalizeOptionalText(input.accountId);
  let opportunityId = normalizeOptionalText(input.opportunityId);

  if (entityType === "contact") {
    contactId = contactId ?? resolveRequiredCanonicalContactId(database, rawEntityId);
    entityId = contactId;
  } else if (entityType === "account") {
    const account = requireCrmAccount(database, accountId ?? rawEntityId);
    accountId = account.id;
    entityId = account.id;
    contactId = contactId ?? account.org_contact_id;
  } else if (entityType === "opportunity") {
    const opportunity = requireCrmOpportunity(database, opportunityId ?? rawEntityId);
    opportunityId = opportunity.id;
    entityId = opportunity.id;
    contactId = contactId ?? opportunity.primary_contact_id;
    accountId = accountId ?? opportunity.account_id;
  } else if (entityType === "task") {
    const task = requireCrmTask(database, rawEntityId);
    entityId = task.id;
    contactId = contactId ?? task.contact_id;
    accountId = accountId ?? task.account_id;
    opportunityId = opportunityId ?? task.opportunity_id;
  } else if (entityType === "activity") {
    const activity = requireCrmActivity(database, rawEntityId);
    entityId = activity.id;
    contactId = contactId ?? activity.contact_id;
    accountId = accountId ?? activity.account_id;
    opportunityId = opportunityId ?? activity.opportunity_id;
  } else {
    if (contactId === null && input.contactRef)
      contactId = resolveRequiredCanonicalContactId(database, input.contactRef);
    if (accountId) requireCrmAccount(database, accountId);
    if (opportunityId) requireCrmOpportunity(database, opportunityId);
  }

  return { entityType, entityId, contactId, accountId, opportunityId };
}

function normalizeCrmFactKey(key: string): string {
  const normalized = key.trim();
  if (!normalized) throw new Error("CRM fact key is required");
  return normalized;
}

export function proposeCrmFact(input: ProposeCrmFactInput): CrmFact {
  const database = ensureDb();
  if (input.value === undefined) throw new Error("CRM fact value must be JSON-serializable");
  const target = resolveCrmFactTarget(database, input);
  const key = normalizeCrmFactKey(input.key);
  const status = getCrmFactStatus(input.status, "proposed");
  const scope = normalizeCrmScope(input.scopeType, input.scopeId);
  const idempotencyKey = normalizeCrmIdempotencyKey(input.idempotencyKey);
  if (idempotencyKey) {
    const existingRow = database.prepare("SELECT * FROM crm_facts WHERE idempotency_key = ?").get(idempotencyKey) as
      | CrmFactRow
      | undefined;
    if (existingRow) return rowToCrmFact(existingRow);
    const existingEvent = getCrmEventRowByIdempotencyKey(database, idempotencyKey);
    if (existingEvent?.event_type.startsWith("crm.fact.")) {
      const payload = parseJsonObject(existingEvent.payload_json);
      const factIdFromEvent = typeof payload?.id === "string" ? payload.id : null;
      const row = factIdFromEvent ? getCrmFactRow(database, factIdFromEvent) : null;
      if (row) return rowToCrmFact(row);
    }
  }

  const factId = `crm_fact_${generateId()}`;
  let fact: CrmFact | null = null;
  const txn = database.transaction(() => {
    database
      .prepare(
        `
        INSERT INTO crm_facts (
          id, entity_type, entity_id, contact_id, account_id, opportunity_id,
          key, value_json, status, source, idempotency_key, confidence, evidence_json,
          scope_type, scope_id, proposed_by_type, proposed_by_id, confirmed_by_type, confirmed_by_id,
          supersedes_fact_id, metadata_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `,
      )
      .run(
        factId,
        target.entityType,
        target.entityId,
        target.contactId,
        target.accountId,
        target.opportunityId,
        key,
        JSON.stringify(input.value),
        status,
        crmMutationSource(input),
        idempotencyKey,
        normalizeCrmConfidence(input.confidence),
        crmEventJson(input.evidence),
        scope.scopeType,
        scope.scopeId,
        normalizeCrmActorType(input.actorType),
        normalizeOptionalText(input.actorId),
        status === "confirmed" ? normalizeCrmActorType(input.actorType) : null,
        status === "confirmed" ? normalizeOptionalText(input.actorId) : null,
        normalizeOptionalText(input.supersedesFactId),
        jsonObject(input.metadata),
      );
    const row = requireCrmFact(database, factId);
    fact = rowToCrmFact(row);
    insertCrmEvent(database, {
      eventType: `crm.fact.${status}`,
      entityType: target.entityType,
      entityId: target.entityId,
      contactId: target.contactId,
      accountId: target.accountId,
      opportunityId: target.opportunityId,
      source: fact.source,
      idempotencyKey,
      actorType: input.actorType,
      actorId: input.actorId,
      confidence: fact.confidence,
      evidence: input.evidence,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      payload: fact,
    });
  });
  txn();
  if (!fact) throw new Error(`CRM fact not created: ${factId}`);
  return fact;
}

function updateCrmFactStatus(input: UpdateCrmFactStatusInput, status: Exclude<CrmFactStatus, "proposed">): CrmFact {
  const database = ensureDb();
  const previous = requireCrmFact(database, input.factId);
  let fact: CrmFact | null = rowToCrmFact(previous);
  if (previous.status === status) return fact;
  const txn = database.transaction(() => {
    database
      .prepare(
        `
        UPDATE crm_facts
        SET status = ?,
            confirmed_by_type = CASE WHEN ? = 'confirmed' THEN ? ELSE confirmed_by_type END,
            confirmed_by_id = CASE WHEN ? = 'confirmed' THEN ? ELSE confirmed_by_id END,
            updated_at = datetime('now')
        WHERE id = ?
      `,
      )
      .run(
        status,
        status,
        normalizeCrmActorType(input.actorType),
        status,
        normalizeOptionalText(input.actorId),
        previous.id,
      );
    const row = requireCrmFact(database, previous.id);
    fact = rowToCrmFact(row);
    insertCrmEvent(database, {
      eventType: `crm.fact.${status}`,
      entityType: previous.entity_type,
      entityId: previous.entity_id,
      contactId: previous.contact_id,
      accountId: previous.account_id,
      opportunityId: previous.opportunity_id,
      source: crmMutationSource(input),
      actorType: input.actorType,
      actorId: input.actorId,
      confidence: input.confidence ?? previous.confidence,
      evidence: input.evidence,
      scopeType: input.scopeType ?? previous.scope_type,
      scopeId: input.scopeId ?? previous.scope_id,
      payload: fact,
      previousPayload: rowToCrmFact(previous),
    });
  });
  txn();
  if (!fact) throw new Error(`CRM fact not updated: ${input.factId}`);
  return fact;
}

export function confirmCrmFact(input: string | UpdateCrmFactStatusInput): CrmFact {
  return updateCrmFactStatus(typeof input === "string" ? { factId: input } : input, "confirmed");
}

export function rejectCrmFact(input: string | UpdateCrmFactStatusInput): CrmFact {
  return updateCrmFactStatus(typeof input === "string" ? { factId: input } : input, "rejected");
}

export function supersedeCrmFact(input: string | UpdateCrmFactStatusInput): CrmFact {
  return updateCrmFactStatus(typeof input === "string" ? { factId: input } : input, "superseded");
}

export function listCrmFacts(options: ListCrmFactsOptions = {}): ListPage<CrmFact> {
  const database = ensureDb();
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (options.entityType?.trim()) {
    where.push("entity_type = ?");
    params.push(normalizeCrmEntityType(options.entityType));
  }
  if (options.entityId?.trim()) {
    where.push("entity_id = ?");
    params.push(options.entityId.trim());
  }
  if (options.contactRef?.trim()) {
    where.push("contact_id = ?");
    params.push(resolveRequiredCanonicalContactId(database, options.contactRef));
  }
  if (options.accountId?.trim()) {
    where.push("account_id = ?");
    params.push(options.accountId.trim());
  }
  if (options.opportunityId?.trim()) {
    where.push("opportunity_id = ?");
    params.push(options.opportunityId.trim());
  }
  if (options.status?.trim()) {
    where.push("status = ?");
    params.push(getCrmFactStatus(options.status));
  }
  if (options.key?.trim()) {
    where.push("key = ?");
    params.push(normalizeCrmFactKey(options.key));
  }
  const { limit, offset } = normalizeLimitOffsetPage(options, { defaultLimit: 25, maxLimit: 500 });
  const total = countRows({ db: database, table: "crm_facts", where, params });
  const rows = database
    .prepare(
      `
      SELECT * FROM crm_facts
      ${buildSqlWhereClause(where)}
      ORDER BY updated_at DESC, created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `,
    )
    .all(...params, limit, offset) as CrmFactRow[];
  return { total, limit, offset, items: rows.map(rowToCrmFact) };
}

function contactEventActivityType(eventType: string): string {
  if (eventType === "profile.note_added") return "note";
  if (eventType.startsWith("interaction.message")) return "message";
  if (eventType.startsWith("interaction.call")) return "call";
  if (eventType.startsWith("crm.task")) return "task";
  if (eventType.startsWith("crm.opportunity")) return "opportunity_update";
  if (eventType.startsWith("crm.contact_profile") || eventType.startsWith("profile.")) return "profile_update";
  return "note";
}

function contactEventSummary(event: ContactEvent): string {
  const payload = event.payload && typeof event.payload === "object" ? (event.payload as Record<string, unknown>) : {};
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (text) return text;
  const nestedPayload =
    payload.payload && typeof payload.payload === "object" ? (payload.payload as Record<string, unknown>) : {};
  const title = typeof nestedPayload.title === "string" ? nestedPayload.title.trim() : "";
  if (title) return title;
  return event.eventType;
}

export function projectContactEventToCrmActivity(input: ProjectContactEventToCrmActivityInput): CrmActivity {
  const database = ensureDb();
  const eventRow = database.prepare("SELECT * FROM contact_events WHERE id = ?").get(input.contactEventId) as
    | ContactEventRow
    | undefined;
  if (!eventRow) throw new Error(`Contact event not found: ${input.contactEventId}`);
  const event = rowToContactEvent(eventRow);
  if (input.accountId) requireCrmAccount(database, input.accountId);
  if (input.opportunityId) requireCrmOpportunity(database, input.opportunityId);
  if (input.taskId) requireCrmTask(database, input.taskId);

  const idempotencyKey = normalizeCrmIdempotencyKey(input.idempotencyKey);
  if (idempotencyKey) {
    const existingRow = database
      .prepare("SELECT * FROM crm_activities WHERE idempotency_key = ?")
      .get(idempotencyKey) as CrmActivityRow | undefined;
    if (existingRow) return rowToCrmActivity(existingRow);
  }
  const activityId = `crm_act_${generateId()}`;
  let activity: CrmActivity | null = null;
  const txn = database.transaction(() => {
    const existing = database.prepare("SELECT * FROM crm_activities WHERE contact_event_id = ?").get(event.id) as
      | CrmActivityRow
      | undefined;
    if (existing) {
      activity = rowToCrmActivity(existing);
      return;
    }

    database
      .prepare(
        `
        INSERT OR IGNORE INTO crm_activities (
          id, activity_type, title, summary, body, occurred_at,
          contact_id, account_id, opportunity_id, task_id, chat_id, session_key,
          message_id, contact_event_id, session_event_id, actor_type, actor_id,
          source, idempotency_key, confidence, evidence_json, payload_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `,
      )
      .run(
        activityId,
        normalizeOptionalText(input.activityType) ?? contactEventActivityType(event.eventType),
        normalizeOptionalText(input.title),
        normalizeOptionalText(input.summary) ?? contactEventSummary(event),
        normalizeOptionalText(input.body),
        event.effectiveAt ?? event.createdAt,
        event.contactId,
        normalizeOptionalText(input.accountId),
        normalizeOptionalText(input.opportunityId),
        normalizeOptionalText(input.taskId),
        event.chatId,
        event.sessionKey,
        event.messageId,
        event.id,
        null,
        event.actorType ?? "unknown",
        event.actorId,
        crmMutationSource(input),
        idempotencyKey,
        input.confidence ?? event.confidence ?? 1,
        crmEventJson(input.evidence ?? event.evidence),
        JSON.stringify({
          contactEventId: event.id,
          contactEventType: event.eventType,
          payload: event.payload,
        }),
      );
    const row = database.prepare("SELECT * FROM crm_activities WHERE contact_event_id = ?").get(event.id) as
      | CrmActivityRow
      | undefined;
    if (!row) throw new Error(`CRM activity not found after projection: ${activityId}`);
    const projectedActivity = rowToCrmActivity(row);
    activity = projectedActivity;
    if (row.id !== activityId) return;
    insertCrmEvent(database, {
      eventType: "crm.activity.logged",
      entityType: "activity",
      entityId: activityId,
      contactId: event.contactId,
      accountId: projectedActivity.accountId,
      opportunityId: projectedActivity.opportunityId,
      taskId: projectedActivity.taskId,
      activityId,
      source: projectedActivity.source,
      idempotencyKey,
      actorType: input.actorType ?? event.actorType,
      actorId: input.actorId ?? event.actorId,
      confidence: projectedActivity.confidence,
      evidence: input.evidence ?? event.evidence,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      payload: projectedActivity,
      emitContactEvent: false,
    });
    upsertCrmActivityParticipant(database, {
      activityId: projectedActivity.id,
      contactId: event.contactId,
      accountId: projectedActivity.accountId,
      role: "subject",
      actorType: event.actorType,
      actorId: event.actorId,
      source: projectedActivity.source,
      confidence: projectedActivity.confidence,
      metadata: { sourceContactEventId: event.id },
    });
  });
  txn();
  if (!activity) throw new Error(`CRM activity not projected: ${activityId}`);
  return activity;
}

function upsertCrmActivityParticipant(
  database: Database,
  input: {
    activityId: string;
    contactId?: string | null;
    accountId?: string | null;
    role?: string | null;
    actorType?: string | null;
    actorId?: string | null;
    source: string;
    confidence?: number | null;
    metadata?: Record<string, unknown> | null;
  },
): CrmActivityParticipantRow {
  const contactId = input.contactId?.trim() || null;
  const accountId = input.accountId?.trim() || null;
  if (!contactId && !accountId) throw new Error("CRM activity participant requires contact or account target");
  const role = normalizeOptionalText(input.role) ?? "participant";
  const id = stableId("crm_ap", [input.activityId, contactId, accountId, role]);
  database
    .prepare(
      `
      INSERT INTO crm_activity_participants (
        id, activity_id, contact_id, account_id, role, actor_type, actor_id,
        source, confidence, metadata_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        contact_id = excluded.contact_id,
        account_id = excluded.account_id,
        role = excluded.role,
        actor_type = excluded.actor_type,
        actor_id = excluded.actor_id,
        source = excluded.source,
        confidence = excluded.confidence,
        metadata_json = excluded.metadata_json,
        updated_at = datetime('now')
    `,
    )
    .run(
      id,
      input.activityId,
      contactId,
      accountId,
      role,
      input.actorType?.trim() || null,
      input.actorId?.trim() || null,
      input.source,
      normalizeCrmConfidence(input.confidence),
      jsonObject(input.metadata),
    );
  const row = database.prepare("SELECT * FROM crm_activity_participants WHERE id = ?").get(id) as
    | CrmActivityParticipantRow
    | undefined;
  if (!row) throw new Error(`CRM activity participant not found after link: ${id}`);
  return row;
}

export function linkCrmActivityParticipant(input: LinkCrmActivityParticipantInput): CrmActivityParticipant {
  const database = ensureDb();
  const activity = requireCrmActivity(database, input.activityId);
  const contactId = input.contactRef ? resolveRequiredCanonicalContactId(database, input.contactRef) : null;
  const accountId = normalizeOptionalText(input.accountId);
  if (accountId) requireCrmAccount(database, accountId);
  let participant: CrmActivityParticipant | null = null;
  const txn = database.transaction(() => {
    const row = upsertCrmActivityParticipant(database, {
      activityId: activity.id,
      contactId,
      accountId,
      role: input.role,
      actorType: input.actorType,
      actorId: input.actorId,
      source: crmMutationSource(input),
      confidence: input.confidence,
      metadata: input.metadata,
    });
    participant = rowToCrmActivityParticipant(row);
    insertCrmEvent(database, {
      eventType: "crm.activity_participant.linked",
      entityType: "activity",
      entityId: activity.id,
      contactId,
      accountId,
      opportunityId: activity.opportunity_id,
      taskId: activity.task_id,
      activityId: activity.id,
      source: participant.source,
      actorType: input.actorType,
      actorId: input.actorId,
      confidence: participant.confidence,
      evidence: input.evidence,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      payload: participant,
    });
  });
  txn();
  if (!participant) throw new Error(`CRM activity participant not linked: ${input.activityId}`);
  return participant;
}

export function listCrmActivityParticipants(activityId: string): CrmActivityParticipant[] {
  const database = ensureDb();
  requireCrmActivity(database, activityId);
  const rows = database
    .prepare("SELECT * FROM crm_activity_participants WHERE activity_id = ? ORDER BY role, created_at, id")
    .all(activityId) as CrmActivityParticipantRow[];
  return rows.map(rowToCrmActivityParticipant);
}

function timelineContactIdsForQuery(database: Database, contactId: string): string[] {
  const seen = new Set<string>([contactId]);
  const pending = [contactId];

  while (pending.length > 0) {
    const currentId = pending.shift()!;
    const rows = database
      .prepare("SELECT payload_json FROM contact_events WHERE contact_id = ? AND event_type = 'identity.merged'")
      .all(currentId) as Array<{ payload_json: string | null }>;

    for (const row of rows) {
      const payload = parseJsonObject(row.payload_json);
      const sourceContactId = typeof payload?.sourceContactId === "string" ? payload.sourceContactId : null;
      if (!sourceContactId || seen.has(sourceContactId)) continue;
      seen.add(sourceContactId);
      pending.push(sourceContactId);
    }
  }

  return [...seen];
}

export function listContactEvents(contactRef: string, options: ListContactEventsOptions = {}): ContactEventsPage {
  const database = ensureDb();
  const contactId = resolveCanonicalContactId(database, contactRef);
  if (!contactId) throw new Error(`Contact not found: ${contactRef}`);

  const contactIds = timelineContactIdsForQuery(database, contactId);
  const where = [`contact_id IN (${contactIds.map(() => "?").join(", ")})`];
  const params: Array<string | number> = [...contactIds];
  if (options.scopeType || options.scopeId) {
    const scope = normalizeContactEventScope(options.scopeType, options.scopeId);
    where.push("scope_type = ?");
    params.push(scope.scopeType);
    if (scope.scopeType === "global") {
      where.push("scope_id IS NULL");
    } else {
      where.push("scope_id = ?");
      params.push(scope.scopeId!);
    }
  }
  if (options.eventType?.trim()) {
    where.push("event_type = ?");
    params.push(options.eventType.trim());
  }

  const { limit, offset } = normalizeLimitOffsetPage(options, { defaultLimit: 50, maxLimit: 500 });
  const total = countRows({ db: database, table: "contact_events", where, params });
  const rows = database
    .prepare(
      `
      SELECT * FROM contact_events
      ${buildSqlWhereClause(where)}
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `,
    )
    .all(...params, limit, offset) as ContactEventRow[];

  return {
    contactId,
    total,
    limit,
    offset,
    items: rows.map(rowToContactEvent),
  };
}

export function addContactNote(
  contactRef: string,
  text: string,
  options: ContactMetadataMutationOptions = {},
): ContactEvent {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Contact note text is required");
  return createContactEvent({
    contactRef,
    eventType: "profile.note_added",
    scopeType: options.scopeType,
    scopeId: options.scopeId,
    source: options.source ?? "cli",
    actorType: options.actorType ?? "user",
    actorId: options.actorId ?? null,
    confidence: options.confidence ?? 1,
    payload: { text: trimmed },
    evidence: options.evidence,
  });
}

export function listContactMetadata(
  contactRef: string,
  options: { scopeType?: ContactEventScopeType | string | null; scopeId?: string | null } = {},
): ContactContextEntry[] {
  const database = ensureDb();
  const contactId = resolveCanonicalContactId(database, contactRef);
  if (!contactId) throw new Error(`Contact not found: ${contactRef}`);

  const where = ["contact_id = ?"];
  const params: string[] = [contactId];
  if (options.scopeType || options.scopeId) {
    const scope = normalizeContactEventScope(options.scopeType, options.scopeId);
    where.push("scope_type = ?", "scope_id = ?");
    params.push(scope.scopeType, scope.storageScopeId);
  }

  const rows = database
    .prepare(
      `
      SELECT * FROM contact_contexts
      ${buildSqlWhereClause(where)}
      ORDER BY scope_type, scope_id, key
    `,
    )
    .all(...params) as ContactContextRow[];
  return rows.map(rowToContactContext);
}

export function setContactMetadata(
  contactRef: string,
  key: string,
  value: unknown,
  options: ContactMetadataMutationOptions = {},
): ContactContextEntry {
  if (value === undefined) throw new Error("Contact metadata value must be JSON-serializable");
  const database = ensureDb();
  const contactId = resolveCanonicalContactId(database, contactRef);
  if (!contactId) throw new Error(`Contact not found: ${contactRef}`);
  const normalizedKey = normalizeContactContextKey(key);
  const scope = normalizeContactEventScope(options.scopeType, options.scopeId);
  const valueJson = JSON.stringify(value);

  const txn = database.transaction(() => {
    const previous = database
      .prepare("SELECT * FROM contact_contexts WHERE contact_id = ? AND scope_type = ? AND scope_id = ? AND key = ?")
      .get(contactId, scope.scopeType, scope.storageScopeId, normalizedKey) as ContactContextRow | undefined;
    database
      .prepare(
        `
        INSERT INTO contact_contexts (
          contact_id, scope_type, scope_id, key, value_json, source, confidence,
          updated_by_type, updated_by_id, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(contact_id, scope_type, scope_id, key) DO UPDATE SET
          value_json = excluded.value_json,
          source = excluded.source,
          confidence = excluded.confidence,
          updated_by_type = excluded.updated_by_type,
          updated_by_id = excluded.updated_by_id,
          updated_at = datetime('now')
      `,
      )
      .run(
        contactId,
        scope.scopeType,
        scope.storageScopeId,
        normalizedKey,
        valueJson,
        options.source?.trim() || "cli",
        options.confidence ?? 1,
        options.actorType ?? "user",
        options.actorId?.trim() || null,
      );
    insertContactEvent(database, {
      contactId,
      eventType: "profile.metadata_set",
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      source: options.source ?? "cli",
      actorType: options.actorType ?? "user",
      actorId: options.actorId ?? null,
      confidence: options.confidence ?? 1,
      payload: {
        key: normalizedKey,
        value,
        previousValue: previous ? parseJsonValue(previous.value_json) : null,
      },
      evidence: options.evidence,
    });
  });
  txn();

  const row = database
    .prepare("SELECT * FROM contact_contexts WHERE contact_id = ? AND scope_type = ? AND scope_id = ? AND key = ?")
    .get(contactId, scope.scopeType, scope.storageScopeId, normalizedKey) as ContactContextRow | undefined;
  if (!row) throw new Error(`Contact metadata not found after set: ${normalizedKey}`);
  return rowToContactContext(row);
}

export function removeContactMetadata(
  contactRef: string,
  key: string,
  options: ContactMetadataMutationOptions = {},
): ContactMetadataRemoveResult {
  const database = ensureDb();
  const contactId = resolveCanonicalContactId(database, contactRef);
  if (!contactId) throw new Error(`Contact not found: ${contactRef}`);
  const normalizedKey = normalizeContactContextKey(key);
  const scope = normalizeContactEventScope(options.scopeType, options.scopeId);
  let previous: ContactContextEntry | null = null;
  let event: ContactEvent | null = null;

  const txn = database.transaction(() => {
    const previousRow = database
      .prepare("SELECT * FROM contact_contexts WHERE contact_id = ? AND scope_type = ? AND scope_id = ? AND key = ?")
      .get(contactId, scope.scopeType, scope.storageScopeId, normalizedKey) as ContactContextRow | undefined;
    if (!previousRow) return;
    previous = rowToContactContext(previousRow);
    database
      .prepare("DELETE FROM contact_contexts WHERE contact_id = ? AND scope_type = ? AND scope_id = ? AND key = ?")
      .run(contactId, scope.scopeType, scope.storageScopeId, normalizedKey);
    event = insertContactEvent(database, {
      contactId,
      eventType: "profile.metadata_removed",
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      source: options.source ?? "cli",
      actorType: options.actorType ?? "user",
      actorId: options.actorId ?? null,
      confidence: options.confidence ?? 1,
      payload: { key: normalizedKey, previousValue: previous.value },
      evidence: options.evidence,
    });
  });
  txn();

  return { removed: previous !== null, previous, event };
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
  const previous = getCanonicalContactById(database, legacyContact.id);
  database
    .prepare("UPDATE contacts SET kind = ?, updated_at = datetime('now') WHERE id = ?")
    .run(kind, legacyContact.id);
  if (previous?.kind !== kind) {
    insertContactEvent(database, {
      contactId: legacyContact.id,
      eventType: "profile.kind_changed",
      source: "contacts",
      actorType: "system",
      confidence: 1,
      payload: { previousKind: previous?.kind ?? null, kind },
    });
  }
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
    if (name !== undefined && name !== null && name !== existing.name) {
      insertContactEvent(database, {
        contactId: existing.id,
        eventType: "profile.name_changed",
        source: source ?? "contacts",
        actorType: "system",
        confidence: 1,
        payload: { previousName: existing.name, name },
      });
    }
    if (existing.status !== status) {
      insertContactEvent(database, {
        contactId: existing.id,
        eventType: "policy.status_changed",
        source: source ?? "contacts",
        actorType: "system",
        confidence: 1,
        payload: { previousStatus: existing.status, status },
      });
    }
  } else {
    // Create new
    const id = generateId();
    const platform = detectPlatform(normalized);
    statements.insertContact.run(id, name ?? null, null, status, source ?? null);
    statements.insertIdentity.run(id, platform, normalized, 1);
    syncContactProjection(database, id);
    insertContactEvent(database, {
      contactId: id,
      eventType: "profile.created",
      source: source ?? "contacts",
      actorType: "system",
      confidence: 1,
      payload: { identity: normalized, platform, name: name ?? null, status },
    });
    insertContactEvent(database, {
      contactId: id,
      eventType: "policy.status_changed",
      source: source ?? "contacts",
      actorType: "system",
      confidence: 1,
      payload: { previousStatus: null, status },
    });
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
    insertContactEvent(database, {
      contactId: id,
      eventType: "profile.created",
      source: "inbound",
      actorType: "system",
      confidence: 1,
      payload: { identity: normalized, platform, name: name ?? null, status: "pending" },
    });
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
  const txn = database.transaction(() => {
    insertContactEvent(database, {
      contactId: contact.id,
      eventType: "profile.deleted",
      source: "contacts",
      actorType: "system",
      confidence: 1,
      payload: {
        contactId: contact.id,
        name: contact.name,
        email: contact.email,
        status: contact.status,
        identities: contact.identities,
      },
    });
    statements.deleteContact.run(contact.id);
    deleteContactProjection(database, contact.id);
  });
  txn();
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
    if (contact.status !== status) {
      insertContactEvent(ensureDb(), {
        contactId: contact.id,
        eventType: "policy.status_changed",
        source: "contacts",
        actorType: "system",
        confidence: 1,
        payload: { previousStatus: contact.status, status },
      });
    }
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
    if (contact.reply_mode !== mode) {
      insertContactEvent(ensureDb(), {
        contactId: contact.id,
        eventType: "policy.reply_mode_changed",
        source: "contacts",
        actorType: "system",
        confidence: 1,
        payload: { previousReplyMode: contact.reply_mode, replyMode: mode },
      });
    }
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
    insertContactEvent(database, {
      contactId: id,
      eventType: "profile.created",
      source: "discovered",
      actorType: "system",
      confidence: 1,
      payload: { identity: normalized, platform, name: name ?? null, status: "discovered" },
    });
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
  insertContactEvent(database, {
    contactId: id,
    eventType: "profile.created",
    source: input.source ?? "contacts",
    actorType: "system",
    confidence: 1,
    payload: {
      identity: normalized,
      platform,
      name: input.name ?? null,
      email: input.email ?? null,
      status: input.status ?? "allowed",
      tags: input.tags ?? [],
    },
  });
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
  if (updates.name !== undefined && updates.name !== contact.name) {
    insertContactEvent(database, {
      contactId: contact.id,
      eventType: "profile.name_changed",
      source: updates.source ?? "contacts",
      actorType: "system",
      confidence: 1,
      payload: { previousName: contact.name, name: updates.name },
    });
  }
  if (updates.email !== undefined && updates.email !== contact.email) {
    insertContactEvent(database, {
      contactId: contact.id,
      eventType: "profile.email_changed",
      source: updates.source ?? "contacts",
      actorType: "system",
      confidence: 1,
      payload: { previousEmail: contact.email, email: updates.email },
    });
  }
  if (updates.status !== undefined && updates.status !== contact.status) {
    insertContactEvent(database, {
      contactId: contact.id,
      eventType: "policy.status_changed",
      source: updates.source ?? "contacts",
      actorType: "system",
      confidence: 1,
      payload: { previousStatus: contact.status, status: updates.status },
    });
  }
  if (updates.reply_mode !== undefined && updates.reply_mode !== contact.reply_mode) {
    insertContactEvent(database, {
      contactId: contact.id,
      eventType: "policy.reply_mode_changed",
      source: updates.source ?? "contacts",
      actorType: "system",
      confidence: 1,
      payload: { previousReplyMode: contact.reply_mode, replyMode: updates.reply_mode },
    });
  }
  if (updates.tags !== undefined) {
    insertContactEvent(database, {
      contactId: contact.id,
      eventType: "profile.metadata_set",
      source: updates.source ?? "contacts",
      actorType: "system",
      confidence: 1,
      payload: { key: "tags", previousValue: contact.tags, value: updates.tags },
    });
  }
  if (updates.notes !== undefined) {
    insertContactEvent(database, {
      contactId: contact.id,
      eventType: "profile.metadata_set",
      source: updates.source ?? "contacts",
      actorType: "system",
      confidence: 1,
      payload: { key: "notes", previousValue: contact.notes, value: updates.notes },
    });
  }
  if (updates.opt_out !== undefined && updates.opt_out !== contact.opt_out) {
    insertContactEvent(database, {
      contactId: contact.id,
      eventType: "policy.opt_out_changed",
      source: updates.source ?? "contacts",
      actorType: "system",
      confidence: 1,
      payload: { previousOptOut: contact.opt_out, optOut: updates.opt_out },
    });
  }
  if (updates.allowedAgents !== undefined) {
    insertContactEvent(database, {
      contactId: contact.id,
      eventType: "policy.allowed_agents_changed",
      source: updates.source ?? "contacts",
      actorType: "system",
      confidence: 1,
      payload: { previousAllowedAgents: contact.allowedAgents, allowedAgents: updates.allowedAgents },
    });
  }
  return getContactById(contact.id)!;
}

/**
 * Find contacts by tag
 */
export function findContactsByTag(tag: string): Contact[] {
  const contactsById = new Map<string, Contact>();
  const addRows = (rows: ContactV2Row[]) => {
    for (const row of rows) {
      const contact = rowToContact(row);
      contactsById.set(contact.id, contact);
    }
  };

  addRows(getStatements().findByTag.all(tag) as ContactV2Row[]);
  const normalizedSlug = normalizeCanonicalTagSlug(tag);
  if (normalizedSlug && normalizedSlug !== tag) {
    addRows(getStatements().findByTag.all(normalizedSlug) as ContactV2Row[]);
  }

  if (normalizedSlug) {
    for (const contactId of canonicalAssetIdsForTag("contact", normalizedSlug) ?? []) {
      const contact = getContactById(contactId);
      if (contact) contactsById.set(contact.id, contact);
    }
  }

  return [...contactsById.values()].sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
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
  insertContactEvent(database, {
    contactId: contact.id,
    eventType: "profile.note_added",
    source: "contacts",
    actorType: "system",
    confidence: 1,
    payload: { notes: newNotes, previousNotes: contact.notes },
  });
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

  const canonicalSlug = attachCanonicalContactTag(contact.id, tag, "contacts.addContactTag");
  if (!canonicalSlug) return;
  const row = database.prepare("SELECT tags FROM contacts_v2 WHERE id = ?").get(contact.id) as
    | { tags: string | null }
    | undefined;
  const legacyTags = legacyContactTagsFromJson(row?.tags ?? null);
  const legacySlugs = new Set(
    legacyTags.map((existing) => normalizeCanonicalTagSlug(existing)).filter((slug): slug is string => slug !== null),
  );
  if (!legacySlugs.has(canonicalSlug)) {
    const tags = [...legacyTags, canonicalSlug];
    database
      .prepare("UPDATE contacts_v2 SET tags = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(tags), contact.id);
  }
  syncContactProjection(database, contact.id);
  insertContactEvent(database, {
    contactId: contact.id,
    eventType: "profile.tag_added",
    source: "contacts",
    actorType: "system",
    confidence: 1,
    payload: { tag: canonicalSlug, originalTag: tag },
  });
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

  const row = database.prepare("SELECT tags FROM contacts_v2 WHERE id = ?").get(contact.id) as
    | { tags: string | null }
    | undefined;
  const canonicalSlug = normalizeCanonicalTagSlug(tag);
  const tags = legacyContactTagsFromJson(row?.tags ?? null).filter(
    (t) => !canonicalSlug || normalizeCanonicalTagSlug(t) !== canonicalSlug,
  );
  if (canonicalSlug) {
    detachTagFromSelector({
      slug: canonicalSlug,
      selector: { target: `contact:${contact.id}` },
      source: "contacts.removeContactTag",
      actor: "contacts",
    });
  }
  database
    .prepare("UPDATE contacts_v2 SET tags = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(tags), contact.id);
  syncContactProjection(database, contact.id);
  if (canonicalSlug) {
    insertContactEvent(database, {
      contactId: contact.id,
      eventType: "profile.tag_removed",
      source: "contacts",
      actorType: "system",
      confidence: 1,
      payload: { tag: canonicalSlug, originalTag: tag },
    });
  }
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
    if (contact.opt_out !== optOut) {
      insertContactEvent(database, {
        contactId: contact.id,
        eventType: "policy.opt_out_changed",
        source: "contacts",
        actorType: "system",
        confidence: 1,
        payload: { previousOptOut: contact.opt_out, optOut },
      });
    }
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
export function addContactIdentity(
  contactId: string,
  platform: string,
  value: string,
  isPrimary = false,
  options: { emitEvent?: boolean } = {},
): void {
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
  if (options.emitEvent !== false) {
    insertContactEvent(database, {
      contactId,
      eventType: "identity.linked",
      source: "contacts",
      actorType: "system",
      confidence: 1,
      payload: { platform, value: normalized, isPrimary },
    });
  }
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
    insertContactEvent(database, {
      contactId: existing.contact_id,
      eventType: "identity.unlinked",
      source: "contacts",
      actorType: "system",
      confidence: 1,
      payload: { platform, value: normalized },
    });
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
  addContactIdentity(contact.id, mapped.legacyPlatform, mapped.legacyValue, false, { emitEvent: false });
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
  insertContactEvent(database, {
    contactId: contact.id,
    eventType: "identity.linked",
    source: "contacts",
    actorType: "system",
    platformIdentityId: current.id,
    confidence: 1,
    payload: {
      channel: current.channel,
      instanceId: current.instance_id,
      platformUserId: current.platform_user_id,
      normalizedPlatformUserId: current.normalized_platform_user_id,
      reason: input.reason ?? "manual",
    },
  });

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
  if (contactId) {
    insertContactEvent(database, {
      contactId,
      eventType: "identity.unlinked",
      source: "contacts",
      actorType: "system",
      platformIdentityId: row.id,
      confidence: 1,
      payload: {
        channel: row.channel,
        instanceId: row.instance_id,
        platformUserId: row.platform_user_id,
        normalizedPlatformUserId: row.normalized_platform_user_id,
        reason: reason ?? "manual",
      },
    });
  }

  if (!contactId) return null;
  syncContactProjection(database, contactId);
  return getContactDetails(contactId);
}

function crmPriorityRank(priority: CrmPriority | null): number {
  if (priority === "urgent") return 4;
  if (priority === "high") return 3;
  if (priority === "normal") return 2;
  if (priority === "low") return 1;
  return 0;
}

function mergeCrmContactProfiles(database: Database, sourceId: string, targetId: string): void {
  const sourceRow = getCrmContactProfileRow(database, sourceId);
  if (!sourceRow) return;
  const targetRow = getCrmContactProfileRow(database, targetId);
  if (!targetRow) {
    database
      .prepare(
        `
        UPDATE crm_contact_profiles
        SET contact_id = ?, metadata_json = ?, updated_at = datetime('now')
        WHERE contact_id = ?
      `,
      )
      .run(
        targetId,
        jsonObject({ ...(parseJsonObject(sourceRow.metadata_json) ?? {}), mergedFromContactId: sourceId }),
        sourceId,
      );
    const movedRow = getCrmContactProfileRow(database, targetId);
    if (movedRow) projectCrmContactProfileMetadata(database, rowToCrmContactProfile(movedRow));
    return;
  }

  const source = rowToCrmContactProfile(sourceRow);
  const target = rowToCrmContactProfile(targetRow);
  const nextPriority =
    crmPriorityRank(source.priority) > crmPriorityRank(target.priority) ? source.priority : target.priority;
  database
    .prepare(
      `
      UPDATE crm_contact_profiles
      SET lifecycle = ?,
          relationship_health = ?,
          priority = ?,
          score = COALESCE(score, ?),
          health_score = COALESCE(health_score, ?),
          owner_type = COALESCE(owner_type, ?),
          owner_id = COALESCE(owner_id, ?),
          primary_account_id = COALESCE(primary_account_id, ?),
          primary_opportunity_id = COALESCE(primary_opportunity_id, ?),
          lead_source = COALESCE(lead_source, ?),
          persona = COALESCE(persona, ?),
          buying_role = COALESCE(buying_role, ?),
          last_meaningful_interaction_at = CASE
            WHEN last_meaningful_interaction_at IS NULL THEN ?
            WHEN ? IS NULL THEN last_meaningful_interaction_at
            WHEN ? > last_meaningful_interaction_at THEN ?
            ELSE last_meaningful_interaction_at
          END,
          next_action_at = COALESCE(next_action_at, ?),
          next_action_summary = COALESCE(next_action_summary, ?),
          next_task_id = COALESCE(next_task_id, ?),
          metadata_json = ?,
          updated_at = datetime('now')
      WHERE contact_id = ?
    `,
    )
    .run(
      target.lifecycle === "unknown" ? source.lifecycle : target.lifecycle,
      target.relationshipHealth === "unknown" ? source.relationshipHealth : target.relationshipHealth,
      nextPriority,
      source.score,
      source.healthScore,
      source.ownerType,
      source.ownerId,
      source.primaryAccountId,
      source.primaryOpportunityId,
      source.leadSource,
      source.persona,
      source.buyingRole,
      source.lastMeaningfulInteractionAt,
      source.lastMeaningfulInteractionAt,
      source.lastMeaningfulInteractionAt,
      source.lastMeaningfulInteractionAt,
      source.nextActionAt,
      source.nextActionSummary,
      source.nextTaskId,
      jsonObject({ ...source.metadata, ...target.metadata, mergedContactIds: [sourceId] }),
      targetId,
    );
  database.prepare("DELETE FROM crm_contact_profiles WHERE contact_id = ?").run(sourceId);
  const mergedRow = getCrmContactProfileRow(database, targetId);
  if (mergedRow) projectCrmContactProfileMetadata(database, rowToCrmContactProfile(mergedRow));
}

function mergeCrmAccountContacts(database: Database, sourceId: string, targetId: string): void {
  const rows = database
    .prepare("SELECT * FROM crm_account_contacts WHERE contact_id = ?")
    .all(sourceId) as CrmAccountContactRow[];
  for (const row of rows) {
    const existing = database
      .prepare("SELECT * FROM crm_account_contacts WHERE account_id = ? AND contact_id = ? AND role = ?")
      .get(row.account_id, targetId, row.role) as CrmAccountContactRow | undefined;
    if (existing) {
      database
        .prepare(
          `
          UPDATE crm_account_contacts
          SET title = COALESCE(title, ?),
              department = COALESCE(department, ?),
              decision_role = CASE WHEN decision_role = 'unknown' THEN ? ELSE decision_role END,
              relationship_strength = CASE WHEN relationship_strength = 'unknown' THEN ? ELSE relationship_strength END,
              is_primary = MAX(is_primary, ?),
              status = CASE WHEN status = 'active' OR ? = 'active' THEN 'active' ELSE status END,
              confidence = MAX(confidence, ?),
              evidence_json = COALESCE(evidence_json, ?),
              metadata_json = ?,
              last_seen_at = datetime('now'),
              updated_at = datetime('now')
          WHERE id = ?
        `,
        )
        .run(
          row.title,
          row.department,
          row.decision_role,
          row.relationship_strength,
          row.is_primary,
          row.status,
          row.confidence,
          row.evidence_json,
          jsonObject({
            ...(parseJsonObject(row.metadata_json) ?? {}),
            ...(parseJsonObject(existing.metadata_json) ?? {}),
          }),
          existing.id,
        );
      database.prepare("DELETE FROM crm_account_contacts WHERE id = ?").run(row.id);
    } else {
      database
        .prepare("UPDATE crm_account_contacts SET id = ?, contact_id = ?, updated_at = datetime('now') WHERE id = ?")
        .run(stableId("crm_ac", [row.account_id, targetId, row.role]), targetId, row.id);
    }
  }
  refreshCrmContactPrimaryAccount(database, targetId);
}

function mergeCrmOpportunityContacts(database: Database, sourceId: string, targetId: string): void {
  const rows = database
    .prepare("SELECT * FROM crm_opportunity_contacts WHERE contact_id = ?")
    .all(sourceId) as CrmOpportunityContactRow[];
  for (const row of rows) {
    const existing = database
      .prepare("SELECT * FROM crm_opportunity_contacts WHERE opportunity_id = ? AND contact_id = ? AND role = ?")
      .get(row.opportunity_id, targetId, row.role) as CrmOpportunityContactRow | undefined;
    if (existing) {
      database
        .prepare(
          `
          UPDATE crm_opportunity_contacts
          SET account_id = COALESCE(account_id, ?),
              influence = CASE WHEN influence = 'unknown' THEN ? ELSE influence END,
              sentiment = CASE WHEN sentiment = 'unknown' THEN ? ELSE sentiment END,
              is_primary = MAX(is_primary, ?),
              confidence = MAX(confidence, ?),
              evidence_json = COALESCE(evidence_json, ?),
              metadata_json = ?,
              updated_at = datetime('now')
          WHERE id = ?
        `,
        )
        .run(
          row.account_id,
          row.influence,
          row.sentiment,
          row.is_primary,
          row.confidence,
          row.evidence_json,
          jsonObject({
            ...(parseJsonObject(row.metadata_json) ?? {}),
            ...(parseJsonObject(existing.metadata_json) ?? {}),
          }),
          existing.id,
        );
      database.prepare("DELETE FROM crm_opportunity_contacts WHERE id = ?").run(row.id);
    } else {
      database
        .prepare(
          "UPDATE crm_opportunity_contacts SET id = ?, contact_id = ?, updated_at = datetime('now') WHERE id = ?",
        )
        .run(stableId("crm_oc", [row.opportunity_id, targetId, row.role]), targetId, row.id);
    }
    if (row.is_primary === 1) refreshCrmOpportunityPrimaryContact(database, row.opportunity_id, targetId);
  }
  database
    .prepare(
      "UPDATE crm_opportunities SET primary_contact_id = ?, updated_at = datetime('now') WHERE primary_contact_id = ?",
    )
    .run(targetId, sourceId);
  refreshCrmContactPrimaryOpportunity(database, targetId);
}

function mergeCrmActivityParticipants(database: Database, sourceId: string, targetId: string): void {
  const rows = database
    .prepare("SELECT * FROM crm_activity_participants WHERE contact_id = ?")
    .all(sourceId) as CrmActivityParticipantRow[];
  for (const row of rows) {
    const nextId = stableId("crm_ap", [row.activity_id, targetId, row.account_id, row.role]);
    const existing = database.prepare("SELECT * FROM crm_activity_participants WHERE id = ?").get(nextId) as
      | CrmActivityParticipantRow
      | undefined;
    if (existing) {
      database
        .prepare(
          `
          UPDATE crm_activity_participants
          SET confidence = MAX(confidence, ?),
              metadata_json = ?,
              updated_at = datetime('now')
          WHERE id = ?
        `,
        )
        .run(
          row.confidence,
          jsonObject({
            ...(parseJsonObject(row.metadata_json) ?? {}),
            ...(parseJsonObject(existing.metadata_json) ?? {}),
          }),
          existing.id,
        );
      database.prepare("DELETE FROM crm_activity_participants WHERE id = ?").run(row.id);
    } else {
      database
        .prepare(
          "UPDATE crm_activity_participants SET id = ?, contact_id = ?, updated_at = datetime('now') WHERE id = ?",
        )
        .run(nextId, targetId, row.id);
    }
  }
}

function mergeCrmContactData(database: Database, sourceId: string, targetId: string): void {
  mergeCrmContactProfiles(database, sourceId, targetId);
  mergeCrmAccountContacts(database, sourceId, targetId);
  mergeCrmOpportunityContacts(database, sourceId, targetId);
  mergeCrmActivityParticipants(database, sourceId, targetId);
  database
    .prepare("UPDATE crm_tasks SET contact_id = ?, updated_at = datetime('now') WHERE contact_id = ?")
    .run(targetId, sourceId);
  database
    .prepare("UPDATE crm_activities SET contact_id = ?, updated_at = datetime('now') WHERE contact_id = ?")
    .run(targetId, sourceId);
  database
    .prepare(
      `
      UPDATE crm_facts
      SET contact_id = ?,
          entity_id = CASE WHEN entity_type = 'contact' AND entity_id = ? THEN ? ELSE entity_id END,
          updated_at = datetime('now')
      WHERE contact_id = ? OR (entity_type = 'contact' AND entity_id = ?)
    `,
    )
    .run(targetId, sourceId, targetId, sourceId, sourceId);
  refreshCrmContactPrimaryAccount(database, targetId);
  refreshCrmContactPrimaryOpportunity(database, targetId);
  refreshCrmContactNextAction(database, targetId);
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
    moveCanonicalContactTagBindings(sourceId, targetId);
    mergeCrmContactData(database, sourceId, targetId);

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
    insertContactEvent(database, {
      contactId: targetId,
      eventType: "identity.merged",
      source: "contacts",
      actorType: "system",
      confidence: 1,
      payload: {
        sourceContactId: sourceId,
        targetContactId: targetId,
        movedIdentityCount: sourceIdentities.length,
        movedCanonicalIdentityIds,
      },
    });
    insertContactEvent(database, {
      contactId: sourceId,
      eventType: "identity.merged",
      source: "contacts",
      actorType: "system",
      confidence: 1,
      payload: {
        sourceContactId: sourceId,
        targetContactId: targetId,
        mergedIntoContactId: targetId,
      },
    });
    insertCrmEvent(database, {
      eventType: "crm.contact.merged",
      entityType: "contact",
      entityId: targetId,
      contactId: targetId,
      source: "contacts",
      actorType: "system",
      confidence: 1,
      payload: {
        sourceContactId: sourceId,
        targetContactId: targetId,
        movedIdentityCount: sourceIdentities.length,
        movedCanonicalIdentityIds,
      },
    });
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
// Legacy group tags — per-group tags stored in notes.groupTags.
// Removal target: chat_participants.metadata_json or a participant annotation
// table once group labels are owned by the chat model instead of group-as-contact.
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
