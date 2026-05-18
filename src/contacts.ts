import { Database } from "bun:sqlite";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { getRaviStateDir } from "./utils/paths.js";
import { executeWrite } from "./db/write-retry.js";
import {
  attachTagSlugsToAsset,
  canonicalAssetIdsForTag,
  canonicalTagSlugsForAsset,
  replaceMirroredTagSlugsForAsset,
} from "./tags/helpers.js";
import { detachTagFromSelector, searchTagBindingsForSelector } from "./tags/service.js";
import { buildSqlWhereClause, countRows, normalizeLimitOffsetPage, type ListPage } from "./utils/pagination.js";
import { nats } from "./nats.js";

// Re-export shared phone helpers.
export {
  normalizePhone,
  isGroup,
  formatPhone,
} from "./utils/phone.js";

import { normalizePhone } from "./utils/phone.js";

function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getRaviStateDir(env), "chat.db");
}

function resolveRouterDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getRaviStateDir(env), "ravi.db");
}

let db: Database | null = null;
let dbPath: string | null = null;

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
  if (db !== null && dbPath === nextDbPath) {
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

  initializeAccountPendingSchema(database);
  initializeIdentitySchema(database);
  initializeCrmSchema(database);

  db = database;
  dbPath = nextDbPath;
  return database;
}

function initializeAccountPendingSchema(database: Database): void {
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

    DROP TRIGGER IF EXISTS trg_contact_events_no_update;
    CREATE TRIGGER trg_contact_events_no_update
      BEFORE UPDATE ON contact_events
      BEGIN
        SELECT RAISE(ABORT, 'contact_events is append-only');
      END;

    DROP TRIGGER IF EXISTS trg_contact_events_no_delete;
    CREATE TRIGGER trg_contact_events_no_delete
      BEFORE DELETE ON contact_events
      BEGIN
        SELECT RAISE(ABORT, 'contact_events is append-only');
      END;

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

function contactTagsFromJson(value: string | null): string[] {
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
      migration: "contact-policy-tags",
      originalTag: tag,
    },
    metadata: {
      mirroredFrom: "contact_policies.tags_json",
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
    source: "contact_policies.tags_json",
    createdBy: "contacts",
    definitionMetadata: {
      source: "contacts",
      migration: "contact-policy-tags",
    },
    metadata: {
      mirroredFrom: "contact_policies.tags_json",
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

function contactTags(contactId: string, tagsJson: string | null): string[] {
  const policySlugs = contactTagsFromJson(tagsJson)
    .map((tag) => normalizeCanonicalTagSlug(tag))
    .filter((tag): tag is string => tag !== null);
  return mergeTagLists(policySlugs, getCanonicalContactTagSlugs(contactId));
}

function contactIdentityIsGroup(platform: string, value: string): boolean {
  return platform === "whatsapp_group" || normalizePhone(value).startsWith("group:");
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
export type ContactIntakeMode = "off" | "discovered" | "pending";
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

export interface EnsureContactFromInboundInput {
  channel: string;
  instanceId?: string | null;
  platformSenderId: string;
  contactIdentity?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  profileData?: unknown;
  chatId?: string | null;
  chatType?: string | null;
  sourceEventId?: string | null;
  providerMessageId?: string | null;
  intakeMode?: ContactIntakeMode | null;
  source?: string | null;
  provenance?: Record<string, unknown> | null;
  defaultTags?: string[] | null;
}

export interface EnsureContactFromInboundResult {
  contact: Contact | null;
  policy: ContactPolicy | null;
  platformIdentity: PlatformIdentity | null;
  createdContact: boolean;
  createdPlatformIdentity: boolean;
  eventIds: string[];
}

export type InboundContactBackfillMode = Exclude<ContactIntakeMode, "off">;

export interface BackfillInboundContactsInput {
  instanceId?: string | null;
  channel?: string | null;
  mode?: InboundContactBackfillMode | null;
  apply?: boolean | null;
  limit?: number | string | null;
  createReadingList?: string | null;
  readingListOwnerType?: string | null;
  readingListOwnerId?: string | null;
}

export interface InboundContactBackfillItem {
  key: string;
  sources: string[];
  action: "create_contact" | "link_existing" | "already_linked" | "skipped";
  skipReason: string | null;
  channel: string;
  instanceId: string;
  chatId: string | null;
  chatType: string | null;
  platformSenderId: string;
  normalizedSenderId: string;
  contactIdentity: string;
  displayName: string | null;
  contactId: string | null;
  platformIdentityId: string | null;
  createdContact: boolean;
  createdPlatformIdentity: boolean;
  messagesUpdated: number;
  participantsUpdated: number;
  readingListMemberAdded: boolean;
}

export interface BackfillInboundContactsResult {
  dryRun: boolean;
  applied: boolean;
  mode: InboundContactBackfillMode;
  filter: {
    instanceId: string | null;
    resolvedInstanceName: string | null;
    resolvedInstanceId: string | null;
    chatInstanceIds: string[];
    accountIds: string[];
    channel: string | null;
  };
  readingList: {
    requestedName: string | null;
    id: string | null;
    ownerType: string | null;
    ownerId: string | null;
  };
  totals: {
    candidates: number;
    eligible: number;
    skipped: number;
    contactsCreated: number;
    contactsLinked: number;
    platformIdentitiesCreated: number;
    messagesUpdated: number;
    participantsUpdated: number;
    readingListMembersAdded: number;
  };
  items: InboundContactBackfillItem[];
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
  phone: string;
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

const CANONICAL_CONTACT_RECENCY_ORDER_SQL = `
  CASE
    WHEN cp.last_inbound_at IS NOT NULL AND cp.last_outbound_at IS NOT NULL THEN
      CASE
        WHEN cp.last_inbound_at >= cp.last_outbound_at THEN cp.last_inbound_at
        ELSE cp.last_outbound_at
      END
    ELSE COALESCE(cp.last_inbound_at, cp.last_outbound_at, cp.updated_at, c.updated_at, c.created_at)
  END DESC,
  cp.updated_at DESC,
  c.updated_at DESC,
  c.created_at DESC,
  c.id DESC
`;

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

function contactPlatformFromCanonicalIdentity(row: PlatformIdentityRow): string {
  return row.channel;
}

function canonicalIdentityValue(row: PlatformIdentityRow): string {
  return row.normalized_platform_user_id || row.platform_user_id;
}

function canonicalIdentityRowsForContact(database: Database, contactId: string): PlatformIdentityRow[] {
  return database
    .prepare(
      `
      SELECT * FROM platform_identities
      WHERE owner_type = 'contact' AND owner_id = ?
      ORDER BY is_primary DESC, channel, instance_id, normalized_platform_user_id
    `,
    )
    .all(contactId) as PlatformIdentityRow[];
}

function getCanonicalCompatIdentities(database: Database, contactId: string): ContactIdentity[] {
  return canonicalIdentityRowsForContact(database, contactId).map((row) => ({
    platform: contactPlatformFromCanonicalIdentity(row),
    value: canonicalIdentityValue(row),
    isPrimary: row.is_primary === 1,
    createdAt: row.created_at,
  }));
}

function rowToCanonicalCompatContact(database: Database, row: CanonicalContactRow): Contact {
  const identities = getCanonicalCompatIdentities(database, row.id);
  const primaryIdentity = identities.find((identity) => identity.isPrimary) ?? identities[0];
  const policy = getContactPolicyById(database, row.id);
  const updatedAt = policy && policy.updatedAt > row.updated_at ? policy.updatedAt : row.updated_at;
  return {
    id: row.id,
    phone: row.primary_phone ?? primaryIdentity?.value ?? row.id,
    name: row.display_name,
    email: row.primary_email ?? null,
    status: policy?.status ?? "allowed",
    agent_id: null,
    reply_mode: policy?.replyMode ?? "auto",
    tags: policy?.tags ?? getCanonicalContactTagSlugs(row.id),
    notes: policy?.notes ?? {},
    opt_out: policy?.optOut ?? false,
    source: policy?.source ?? null,
    allowedAgents: policy?.allowedAgents ?? null,
    identities,
    last_inbound_at: policy?.lastInboundAt ?? null,
    last_outbound_at: policy?.lastOutboundAt ?? null,
    interaction_count: policy?.interactionCount ?? 0,
    created_at: row.created_at,
    updated_at: updatedAt,
  };
}

function getCanonicalCompatContactById(database: Database, contactId: string): Contact | null {
  const row = database.prepare("SELECT * FROM contacts WHERE id = ?").get(contactId) as CanonicalContactRow | undefined;
  return row ? rowToCanonicalCompatContact(database, row) : null;
}

function findCanonicalContactByIdentity(database: Database, identity: string): Contact | null {
  const raw = identity.trim();
  const normalized = normalizePhone(raw);
  const emailNormalized = raw.toLowerCase();
  const candidates = new Set<string>([raw, normalized, emailNormalized]);
  if (/^\d+$/.test(normalized) && !normalized.startsWith("lid:")) {
    candidates.add(`lid:${normalized}`);
  }

  for (const candidate of candidates) {
    const byId = getCanonicalCompatContactById(database, candidate);
    if (byId) return byId;
  }

  const platformIdentity = findDefaultPlatformIdentityForIdentity(database, raw);
  if (platformIdentity?.owner_type === "agent") return null;
  if (platformIdentity?.owner_type === "contact" && platformIdentity.owner_id) {
    const byOwner = getCanonicalCompatContactById(database, platformIdentity.owner_id);
    if (byOwner) return byOwner;
  }

  const values = [...candidates];
  const placeholders = values.map(() => "?").join(", ");
  const byPrimary = database
    .prepare(
      `
      SELECT * FROM contacts
      WHERE primary_phone COLLATE NOCASE IN (${placeholders})
         OR primary_email COLLATE NOCASE IN (${placeholders})
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    )
    .get(...values, ...values) as CanonicalContactRow | undefined;
  if (byPrimary) return rowToCanonicalCompatContact(database, byPrimary);

  const row = database
    .prepare(
      `
      SELECT c.* FROM contacts c
      JOIN platform_identities pi ON pi.owner_type = 'contact' AND pi.owner_id = c.id
      WHERE pi.id = ?
         OR pi.normalized_platform_user_id COLLATE NOCASE IN (${placeholders})
         OR pi.platform_user_id COLLATE NOCASE IN (${placeholders})
      ORDER BY pi.is_primary DESC, pi.updated_at DESC
      LIMIT 1
    `,
    )
    .get(raw, ...values, ...values) as CanonicalContactRow | undefined;
  return row ? rowToCanonicalCompatContact(database, row) : null;
}

function findDefaultPlatformIdentityForIdentity(database: Database, identity: string): PlatformIdentityRow | null {
  try {
    const mapped = mapLinkInput(detectPlatform(identity), identity);
    return findPlatformIdentityByChannelRef(database, {
      channel: mapped.canonicalChannel,
      instanceId: "",
      platformUserId: mapped.normalizedValue,
    });
  } catch {
    return null;
  }
}

function upsertCanonicalContactRecord(
  database: Database,
  input: {
    id: string;
    displayName?: string | null;
    primaryPhone?: string | null;
    primaryEmail?: string | null;
    avatarUrl?: string | null;
    metadata?: Record<string, unknown> | null;
    coalesceDisplayName?: boolean;
  },
): void {
  const displayNameAssignment = input.coalesceDisplayName
    ? "display_name = COALESCE(contacts.display_name, excluded.display_name)"
    : "display_name = excluded.display_name";
  database
    .prepare(
      `
      INSERT INTO contacts (
        id, kind, display_name, primary_phone, primary_email, avatar_url, metadata_json, created_at, updated_at
      )
      VALUES (?, 'person', ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        ${displayNameAssignment},
        primary_phone = COALESCE(excluded.primary_phone, contacts.primary_phone),
        primary_email = COALESCE(excluded.primary_email, contacts.primary_email),
        avatar_url = COALESCE(excluded.avatar_url, contacts.avatar_url),
        metadata_json = COALESCE(excluded.metadata_json, contacts.metadata_json),
        updated_at = datetime('now')
    `,
    )
    .run(
      input.id,
      input.displayName ?? null,
      input.primaryPhone ?? null,
      input.primaryEmail ?? null,
      input.avatarUrl ?? null,
      input.metadata ? metadataJson(input.metadata) : null,
    );
}

function upsertCanonicalContactPolicy(
  database: Database,
  input: {
    contactId: string;
    status?: ContactStatus | null;
    replyMode?: ReplyMode | null;
    allowedAgents?: string[] | null;
    optOut?: boolean | null;
    tags?: string[] | null;
    notes?: Record<string, unknown> | null;
    source?: ContactSource | null;
  },
): void {
  database
    .prepare(
      `
      INSERT INTO contact_policies (
        contact_id, status, reply_mode, allowed_agents_json, opt_out, tags_json, notes_json,
        source, interaction_count, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
      ON CONFLICT(contact_id) DO UPDATE SET
        status = CASE
          WHEN ? = 1 THEN excluded.status
          ELSE contact_policies.status
        END,
        reply_mode = CASE
          WHEN ? = 1 THEN excluded.reply_mode
          ELSE contact_policies.reply_mode
        END,
        allowed_agents_json = CASE
          WHEN ? = 1 THEN excluded.allowed_agents_json
          ELSE contact_policies.allowed_agents_json
        END,
        opt_out = CASE
          WHEN ? = 1 THEN excluded.opt_out
          ELSE contact_policies.opt_out
        END,
        tags_json = CASE
          WHEN ? = 1 THEN excluded.tags_json
          ELSE contact_policies.tags_json
        END,
        notes_json = CASE
          WHEN ? = 1 THEN excluded.notes_json
          ELSE contact_policies.notes_json
        END,
        source = CASE
          WHEN ? = 1 THEN excluded.source
          ELSE contact_policies.source
        END,
        updated_at = datetime('now')
    `,
    )
    .run(
      input.contactId,
      input.status ?? "allowed",
      input.replyMode ?? "auto",
      input.allowedAgents === undefined ? null : JSON.stringify(input.allowedAgents),
      input.optOut === undefined || input.optOut === null ? 0 : input.optOut ? 1 : 0,
      input.tags === undefined ? null : JSON.stringify(input.tags ?? []),
      input.notes === undefined ? null : JSON.stringify(input.notes ?? {}),
      input.source ?? null,
      input.status === undefined ? 0 : 1,
      input.replyMode === undefined ? 0 : 1,
      input.allowedAgents === undefined ? 0 : 1,
      input.optOut === undefined ? 0 : 1,
      input.tags === undefined ? 0 : 1,
      input.notes === undefined ? 0 : 1,
      input.source === undefined ? 0 : 1,
    );
  if (input.tags !== undefined) {
    syncCanonicalContactTags(input.contactId, input.tags ?? []);
  }
}

function canonicalPrimaryPhoneForIdentity(mapped: {
  canonicalChannel: string;
  normalizedValue: string;
}): string | null {
  return mapped.canonicalChannel === "phone" ? mapped.normalizedValue : null;
}

function createCanonicalContactForIdentity(
  database: Database,
  identity: string,
  input: {
    name?: string | null;
    email?: string | null;
    status: ContactStatus;
    source?: ContactSource | null;
    tags?: string[] | null;
    notes?: Record<string, unknown> | null;
  },
): Contact {
  const mapped = mapLinkInput(detectPlatform(identity), identity);
  const id = generateId();
  assertPlatformIdentityCanBeOwnedBy(
    findPlatformIdentityByChannelRef(database, {
      channel: mapped.canonicalChannel,
      instanceId: "",
      platformUserId: mapped.normalizedValue,
    }),
    "contact",
    id,
  );
  upsertCanonicalContactRecord(database, {
    id,
    displayName: input.name ?? null,
    primaryPhone: canonicalPrimaryPhoneForIdentity(mapped),
    primaryEmail: input.email ?? null,
    metadata: { source: "contacts", identityModel: "canonical" },
  });
  upsertCanonicalContactPolicy(database, {
    contactId: id,
    status: input.status,
    replyMode: "auto",
    tags: input.tags ?? [],
    notes: input.notes ?? {},
    source: input.source ?? null,
  });
  const platformIdentity = upsertCanonicalPlatformIdentity(database, id, mapped, {
    platformUserId: identity,
    reason: input.source ?? "contacts",
  });
  database
    .prepare("UPDATE platform_identities SET is_primary = 1, updated_at = datetime('now') WHERE id = ?")
    .run(platformIdentity.id);
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
      stableId("ile", ["link", id, platformIdentity.id, input.source ?? "contacts"]),
      id,
      platformIdentity.id,
      input.source ?? "contacts",
      metadataJson({ source: "contacts", channel: mapped.canonicalChannel }),
    );
  return getCanonicalCompatContactById(database, id)!;
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

function crmEventJson(value: unknown, defaultValue: unknown = null): string | null {
  if (value === undefined) {
    return defaultValue === null ? null : JSON.stringify(defaultValue);
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

function getCrmFactStatus(
  value?: CrmFactStatus | string | null,
  defaultStatus: CrmFactStatus = "proposed",
): CrmFactStatus {
  return normalizeCrmEnum<CrmFactStatus>(value, CRM_FACT_STATUSES, defaultStatus);
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

function normalizeCrmEnum<T extends string>(
  value: string | null | undefined,
  allowed: Set<string>,
  defaultValue: T,
): T {
  const normalized = value?.trim().toLowerCase() || defaultValue;
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
    tags: contactTagsFromJson(row.tags_json),
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
  const contactId = resolveCanonicalContactId(database, contactRef);
  return contactId ? getContactDetailsByCanonicalId(database, contactId, options) : null;
}

function resolveCanonicalContactId(database: Database, contactRef: string): string | null {
  const identity = findPlatformIdentityByRef(database, contactRef);
  if (identity?.owner_type === "contact" && identity.owner_id) return identity.owner_id;

  const contact = resolveContact(contactRef);
  if (!contact) return null;
  if (!getCanonicalContactById(database, contact.id)) return null;
  return contact.id;
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
  return executeWrite(database, () => insertCrmEvent(database, input), { label: "contacts:createCrmEvent" });
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
  executeWrite(
    database,
    () => {
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
    },
    { label: "contacts:updateCrmContactProfile" },
  );
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
  executeWrite(
    database,
    () => {
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
    },
    { label: "contacts:createCrmAccount" },
  );
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
    const selected = database
      .prepare(
        `
        SELECT account_id FROM crm_account_contacts
        WHERE contact_id = ? AND is_primary = 1
        ORDER BY updated_at DESC, account_id
        LIMIT 1
      `,
      )
      .get(contactId) as { account_id: string } | undefined;
    nextAccountId = selected?.account_id ?? null;
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
  executeWrite(
    database,
    () => {
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
    },
    { label: "contacts:linkCrmAccountContact" },
  );
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

function opportunityStatusForStage(stage: CrmPipelineStage, currentStatus: CrmOpportunityStatus): CrmOpportunityStatus {
  if (stage.category === "terminal_won") return "won";
  if (stage.category === "terminal_lost") return "lost";
  if (currentStatus === "won" || currentStatus === "lost") return "open";
  return currentStatus;
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
  executeWrite(
    database,
    () => {
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
    },
    { label: "contacts:createCrmOpportunity" },
  );
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
    const selected = database
      .prepare(
        `
        SELECT opportunity_id FROM crm_opportunity_contacts
        WHERE contact_id = ? AND is_primary = 1
        ORDER BY updated_at DESC, opportunity_id
        LIMIT 1
      `,
      )
      .get(contactId) as { opportunity_id: string } | undefined;
    nextOpportunityId = selected?.opportunity_id ?? null;
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
    const selected = database
      .prepare(
        `
        SELECT contact_id FROM crm_opportunity_contacts
        WHERE opportunity_id = ? AND is_primary = 1
        ORDER BY updated_at DESC, contact_id
        LIMIT 1
      `,
      )
      .get(opportunityId) as { contact_id: string } | undefined;
    nextContactId = selected?.contact_id ?? null;
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
  executeWrite(
    database,
    () => {
      const previous = database.prepare("SELECT * FROM crm_opportunity_contacts WHERE id = ?").get(id) as
        | CrmOpportunityContactRow
        | undefined;
      const affectedContactIds = new Set<string>([contactId]);
      if (input.isPrimary) {
        const previousPrimaryRows = database
          .prepare(
            "SELECT DISTINCT contact_id FROM crm_opportunity_contacts WHERE opportunity_id = ? AND is_primary = 1",
          )
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
        const nextPrimaryContactId = refreshCrmOpportunityPrimaryContact(database, opportunity.id);
        if (nextPrimaryContactId) affectedContactIds.add(nextPrimaryContactId);
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
    },
    { label: "contacts:linkCrmOpportunityContact" },
  );
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
  executeWrite(
    database,
    () => {
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
    },
    { label: "contacts:moveCrmOpportunityStage" },
  );
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
  executeWrite(
    database,
    () => {
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
    },
    { label: "contacts:createCrmTask" },
  );
  if (!task) throw new Error(`CRM task not created: ${taskId}`);
  return task;
}

export function completeCrmTask(input: CompleteCrmTaskInput): CrmTask {
  const database = ensureDb();
  const previous = requireCrmTask(database, input.taskId);
  let task: CrmTask | null = rowToCrmTask(previous);
  if (previous.status === "done") return task;
  executeWrite(
    database,
    () => {
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
    },
    { label: "contacts:completeCrmTask" },
  );
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
  executeWrite(
    database,
    () => {
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
    },
    { label: "contacts:proposeCrmFact" },
  );
  if (!fact) throw new Error(`CRM fact not created: ${factId}`);
  return fact;
}

function updateCrmFactStatus(input: UpdateCrmFactStatusInput, status: Exclude<CrmFactStatus, "proposed">): CrmFact {
  const database = ensureDb();
  const previous = requireCrmFact(database, input.factId);
  let fact: CrmFact | null = rowToCrmFact(previous);
  if (previous.status === status) return fact;
  executeWrite(
    database,
    () => {
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
    },
    { label: "contacts:updateCrmFactStatus" },
  );
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
  executeWrite(
    database,
    () => {
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
    },
    { label: "contacts:projectContactEventToCrmActivity" },
  );
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
  executeWrite(
    database,
    () => {
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
    },
    { label: "contacts:linkCrmActivityParticipant" },
  );
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

  executeWrite(
    database,
    () => {
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
    },
    { label: "contacts:setContactMetadata" },
  );

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

  executeWrite(
    database,
    () => {
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
    },
    { label: "contacts:removeContactMetadata" },
  );

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

function contactStatusFromIntakeMode(mode?: ContactIntakeMode | null): ContactStatus | null {
  if (mode === "discovered" || mode === "pending") return mode;
  return null;
}

function shouldApplyInboundIntakeStatus(policy: ContactPolicy | null, desiredStatus: ContactStatus): boolean {
  if (!policy) return true;
  if (policy.optOut) return false;
  if (policy.status === "allowed" || policy.status === "blocked") return false;
  if (policy.status === "pending" && desiredStatus === "discovered") return false;
  return policy.status !== desiredStatus;
}

function inboundIntakeEventEvidence(input: EnsureContactFromInboundInput): Record<string, unknown> {
  return {
    source: input.source?.trim() || "inbound_contact_intake",
    channel: input.channel,
    instanceId: input.instanceId ?? null,
    platformSenderId: input.platformSenderId,
    contactIdentity: input.contactIdentity ?? null,
    chatId: input.chatId ?? null,
    chatType: input.chatType ?? null,
    sourceEventId: input.sourceEventId ?? null,
    providerMessageId: input.providerMessageId ?? null,
    provenance: input.provenance ?? null,
  };
}

function upsertInboundContactPlatformIdentity(
  database: Database,
  contactId: string,
  input: {
    channel: string;
    instanceId?: string | null;
    platformUserId: string;
    displayName?: string | null;
    avatarUrl?: string | null;
    profileData?: unknown;
    confidence?: number | null;
  },
): { identity: PlatformIdentity; created: boolean } {
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
  assertPlatformIdentityCanBeOwnedBy(existing, "contact", contactId);

  const platformIdentityId = existing?.id ?? stableId("pi", [instanceId, channel, normalizedPlatformUserId]);
  const profileDataJson =
    input.profileData === undefined
      ? metadataJson({ source: "inbound_contact_intake", rawPlatformUserId, instanceId })
      : JSON.stringify(input.profileData);
  const confidence = input.confidence ?? 1.0;

  database
    .prepare(
      `
      INSERT INTO platform_identities (
        id, owner_type, owner_id, channel, instance_id, platform_user_id, normalized_platform_user_id,
        platform_display_name, avatar_url, profile_data_json, is_primary, confidence, linked_by, link_reason,
        first_seen_at, last_seen_at, created_at, updated_at
      )
      VALUES (?, 'contact', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'auto', 'inbound_contact_intake', datetime('now'), datetime('now'), datetime('now'), datetime('now'))
      ON CONFLICT(channel, instance_id, normalized_platform_user_id) DO UPDATE SET
        owner_type = excluded.owner_type,
        owner_id = excluded.owner_id,
        platform_user_id = excluded.platform_user_id,
        platform_display_name = COALESCE(excluded.platform_display_name, platform_identities.platform_display_name),
        avatar_url = COALESCE(excluded.avatar_url, platform_identities.avatar_url),
        profile_data_json = COALESCE(excluded.profile_data_json, platform_identities.profile_data_json),
        confidence = MAX(platform_identities.confidence, excluded.confidence),
        linked_by = COALESCE(platform_identities.linked_by, excluded.linked_by),
        link_reason = COALESCE(platform_identities.link_reason, excluded.link_reason),
        last_seen_at = datetime('now'),
        updated_at = datetime('now')
    `,
    )
    .run(
      platformIdentityId,
      contactId,
      channel,
      instanceId,
      rawPlatformUserId,
      normalizedPlatformUserId,
      input.displayName ?? null,
      input.avatarUrl ?? null,
      profileDataJson,
      confidence,
    );

  const row = findPlatformIdentityByChannelRef(database, { channel, instanceId, platformUserId: rawPlatformUserId });
  if (!row)
    throw new Error(`Platform identity not found after inbound contact upsert: ${channel}:${normalizedPlatformUserId}`);
  assertPlatformIdentityCanBeOwnedBy(row, "contact", contactId);
  return { identity: rowToPlatformIdentity(row), created: !existing };
}

export function ensureContactFromInbound(input: EnsureContactFromInboundInput): EnsureContactFromInboundResult {
  const database = ensureDb();
  const channel = normalizePlatformIdentityChannel(input.channel);
  if (!channel) throw new Error("Channel is required");
  const instanceId = input.instanceId?.trim() ?? "";
  const platformSenderId = input.platformSenderId.trim();
  if (!platformSenderId) throw new Error("Platform sender id is required");
  const contactIdentity = (input.contactIdentity?.trim() || platformSenderId).trim();
  const desiredStatus = contactStatusFromIntakeMode(input.intakeMode ?? "off");
  const intakeSource = input.source?.trim() || "inbound_contact_intake";
  const eventIds: string[] = [];

  let contact: Contact | null = null;
  let policy: ContactPolicy | null = null;
  let platformIdentity: PlatformIdentity | null = null;
  let createdContact = false;
  let createdPlatformIdentity = false;

  executeWrite(
    database,
    () => {
      const existingIdentity = findPlatformIdentityByChannelRef(database, {
        channel,
        instanceId,
        platformUserId: platformSenderId,
      });
      if (existingIdentity?.owner_type === "agent") {
        platformIdentity = rowToPlatformIdentity(existingIdentity);
        return;
      }

      if (existingIdentity?.owner_type === "contact" && existingIdentity.owner_id) {
        contact = getCanonicalCompatContactById(database, existingIdentity.owner_id);
        platformIdentity = rowToPlatformIdentity(existingIdentity);
      }
      if (!contact && contactIdentity) {
        contact = findCanonicalContactByIdentity(database, contactIdentity);
      }

      if (!desiredStatus && !contact) {
        return;
      }
      if (!desiredStatus && contact) {
        policy = getContactPolicyById(database, contact.id);
        return;
      }
      if (normalizePhone(contactIdentity).startsWith("group:")) {
        return;
      }

      const evidence = inboundIntakeEventEvidence(input);

      if (!contact) {
        contact = createCanonicalContactForIdentity(database, contactIdentity, {
          name: input.displayName ?? null,
          status: desiredStatus!,
          source: "inbound",
          tags: [],
          notes: {},
        });
        createdContact = true;
        const createdEvent = insertContactEvent(database, {
          contactId: contact.id,
          eventType: "profile.created",
          source: intakeSource,
          actorType: "system",
          confidence: 1,
          chatId: input.chatId,
          messageId: input.providerMessageId ?? input.sourceEventId,
          payload: {
            status: desiredStatus,
            contactIdentity,
            displayName: input.displayName ?? null,
          },
          evidence,
        });
        eventIds.push(createdEvent.id);
      } else {
        upsertCanonicalContactRecord(database, {
          id: contact.id,
          displayName: input.displayName ?? null,
          avatarUrl: input.avatarUrl ?? null,
          coalesceDisplayName: true,
        });
        contact = getCanonicalCompatContactById(database, contact.id);
      }

      if (!contact) return;
      policy = getContactPolicyById(database, contact.id);
      if (desiredStatus && shouldApplyInboundIntakeStatus(policy, desiredStatus)) {
        const previousStatus = policy?.status ?? null;
        upsertCanonicalContactPolicy(database, {
          contactId: contact.id,
          status: desiredStatus,
          source: "inbound",
        });
        policy = getContactPolicyById(database, contact.id);
        const statusEvent = insertContactEvent(database, {
          contactId: contact.id,
          eventType: "policy.status_changed",
          source: intakeSource,
          actorType: "system",
          confidence: 1,
          chatId: input.chatId,
          messageId: input.providerMessageId ?? input.sourceEventId,
          payload: { previousStatus, status: desiredStatus },
          evidence,
        });
        eventIds.push(statusEvent.id);
      }

      const linked = upsertInboundContactPlatformIdentity(database, contact.id, {
        channel,
        instanceId,
        platformUserId: platformSenderId,
        displayName: input.displayName ?? null,
        avatarUrl: input.avatarUrl ?? null,
        profileData:
          input.profileData === undefined
            ? {
                source: "inbound_contact_intake",
                rawPlatformUserId: platformSenderId,
                instanceId,
                provenance: input.provenance ?? null,
              }
            : input.profileData,
      });
      platformIdentity = linked.identity;
      createdPlatformIdentity = linked.created;

      database
        .prepare(
          `
        INSERT OR IGNORE INTO identity_link_events (
          id, event_type, target_owner_type, target_owner_id, platform_identity_id,
          confidence, reason, actor_type, metadata_json
        )
        VALUES (?, 'auto_link', 'contact', ?, ?, 1.0, 'inbound_contact_intake', 'system', ?)
      `,
        )
        .run(
          stableId("ile", ["auto_link", contact.id, platformIdentity.id, "inbound_contact_intake"]),
          contact.id,
          platformIdentity.id,
          metadataJson({ source: "inbound_contact_intake", channel, instanceId, chatId: input.chatId ?? null }),
        );

      if (linked.created) {
        const linkEvent = insertContactEvent(database, {
          contactId: contact.id,
          eventType: "identity.linked",
          source: intakeSource,
          actorType: "system",
          platformIdentityId: platformIdentity.id,
          chatId: input.chatId,
          messageId: input.providerMessageId ?? input.sourceEventId,
          confidence: 1,
          payload: {
            channel,
            instanceId,
            platformUserId: platformSenderId,
            normalizedPlatformUserId: platformIdentity.normalizedPlatformUserId,
          },
          evidence,
        });
        eventIds.push(linkEvent.id);
      }

      if (createdContact && Array.isArray(input.defaultTags) && input.defaultTags.length > 0) {
        const refreshedContact = getCanonicalCompatContactById(database, contact.id);
        const existingTags = refreshedContact?.tags ?? contact.tags;
        const appliedSlugs: string[] = [];
        for (const tag of input.defaultTags) {
          const slug = attachCanonicalContactTag(contact.id, tag, "inbound_contact_intake_default_tag");
          if (slug) appliedSlugs.push(slug);
        }
        if (appliedSlugs.length > 0) {
          const mergedTags = mergeTagLists(existingTags, appliedSlugs);
          upsertCanonicalContactPolicy(database, {
            contactId: contact.id,
            tags: mergedTags,
          });
          const tagsEvent = insertContactEvent(database, {
            contactId: contact.id,
            eventType: "profile.tag_added",
            source: intakeSource,
            actorType: "system",
            confidence: 1,
            chatId: input.chatId,
            messageId: input.providerMessageId ?? input.sourceEventId,
            payload: {
              tags: appliedSlugs,
              reason: "instance_default_contact_tags",
              instanceId,
            },
            evidence,
          });
          eventIds.push(tagsEvent.id);
        }
      }

      contact = getCanonicalCompatContactById(database, contact.id);
      policy = contact ? getContactPolicyById(database, contact.id) : null;
    },
    { label: "contacts:ensureContactFromInbound" },
  );

  return {
    contact,
    policy,
    platformIdentity,
    createdContact,
    createdPlatformIdentity,
    eventIds,
  };
}

interface InboundContactBackfillCandidate {
  key: string;
  sources: string[];
  channel: string;
  instanceId: string;
  chatId: string | null;
  chatType: string | null;
  platformSenderId: string;
  normalizedSenderId: string;
  contactIdentity: string;
  displayName: string | null;
  avatarUrl: string | null;
  providerMessageId: string | null;
  firstSeenAt: number | null;
  lastSeenAt: number | null;
  provenance: Record<string, unknown>;
}

interface ChatBackfillRow {
  id: string;
  channel: string;
  instance_id: string;
  platform_chat_id: string;
  normalized_chat_id: string;
  chat_type: string;
  title: string | null;
  avatar_url: string | null;
  raw_provenance_json: string | null;
  first_seen_at: number;
  last_seen_at: number;
}

interface AccountPendingBackfillRow {
  account_id: string;
  phone: string;
  name: string | null;
  chat_id: string | null;
  is_group: number;
  created_at: number;
  updated_at: number;
}

interface ChatMessageBackfillRow {
  id: string;
  provider_message_id: string;
  raw_sender_id: string | null;
  normalized_sender_id: string | null;
  provider_timestamp: number | null;
  ingested_at: number;
  raw_provenance_json: string | null;
}

interface BackfillInstanceRow {
  name: string;
  instance_id: string | null;
  default_contact_tags: string | null;
}

interface BackfillInstanceFilter {
  requested: string | null;
  resolvedInstanceName: string | null;
  resolvedInstanceId: string | null;
  chatInstanceIds: string[];
  accountIds: string[];
  defaultContactTags: string[];
}

function normalizeBackfillMode(mode?: InboundContactBackfillMode | null): InboundContactBackfillMode {
  if (!mode) return "pending";
  if (mode !== "pending" && mode !== "discovered") {
    throw new Error("Backfill mode must be 'pending' or 'discovered'");
  }
  return mode;
}

function normalizeBackfillLimit(limit?: number | string | null): number | null {
  if (limit === null || limit === undefined || limit === "") return null;
  const parsed = Number(limit);
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error("limit must be a positive number");
  return Math.floor(parsed);
}

function sqliteTableExists(database: Database, table: string): boolean {
  return !!database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

function sqliteColumnExists(database: Database, table: string, column: string): boolean {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function uniqueNonEmptyStrings(values: Array<string | null | undefined>): string[] {
  return values
    .map((value) => value?.trim() ?? "")
    .filter((value, index, all) => value !== "" && all.indexOf(value) === index);
}

function openBackfillRouterDb(): Database | null {
  const routerDbPath = resolveRouterDbPath();
  if (!existsSync(routerDbPath)) return null;
  const database = new Database(routerDbPath);
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("PRAGMA foreign_keys = ON");
  return database;
}

function resolveBackfillInstanceFilter(database: Database | null, requested?: string | null): BackfillInstanceFilter {
  const cleanRequested = requested?.trim() || null;
  if (!cleanRequested) {
    return {
      requested: null,
      resolvedInstanceName: null,
      resolvedInstanceId: null,
      chatInstanceIds: [],
      accountIds: [],
      defaultContactTags: [],
    };
  }

  let resolved: BackfillInstanceRow | null = null;
  if (database && sqliteTableExists(database, "instances")) {
    const activeInstanceClause = sqliteColumnExists(database, "instances", "deleted_at")
      ? "AND deleted_at IS NULL"
      : "";
    const tagColumnPresent = sqliteColumnExists(database, "instances", "default_contact_tags");
    resolved =
      (database
        .prepare(
          `
          SELECT name, instance_id, ${tagColumnPresent ? "default_contact_tags" : "NULL AS default_contact_tags"}
          FROM instances
          WHERE 1 = 1
            ${activeInstanceClause}
            AND (name = ? OR instance_id = ?)
          LIMIT 1
        `,
        )
        .get(cleanRequested, cleanRequested) as BackfillInstanceRow | undefined) ?? null;
  }

  const instanceName = resolved?.name ?? null;
  const instanceId = resolved?.instance_id ?? null;
  let defaultContactTags: string[] = [];
  if (resolved?.default_contact_tags) {
    try {
      const parsed = JSON.parse(resolved.default_contact_tags);
      if (Array.isArray(parsed)) {
        defaultContactTags = parsed
          .filter((value): value is string => typeof value === "string")
          .map((tag) => tag.trim())
          .filter((tag) => tag.length > 0);
      }
    } catch {
      defaultContactTags = [];
    }
  }
  return {
    requested: cleanRequested,
    resolvedInstanceName: instanceName,
    resolvedInstanceId: instanceId,
    chatInstanceIds: uniqueNonEmptyStrings([cleanRequested, instanceId, instanceName]),
    accountIds: uniqueNonEmptyStrings([cleanRequested, instanceName, instanceId]),
    defaultContactTags,
  };
}

function sqlPlaceholders(values: unknown[]): string {
  return values.map(() => "?").join(", ");
}

function backfillSenderCandidates(
  candidate: Pick<InboundContactBackfillCandidate, "platformSenderId" | "normalizedSenderId" | "contactIdentity">,
): string[] {
  return [
    candidate.platformSenderId,
    candidate.normalizedSenderId,
    candidate.contactIdentity,
    normalizePhone(candidate.platformSenderId),
    normalizePhone(candidate.contactIdentity),
  ]
    .map((value) => value.trim())
    .filter((value, index, values) => value !== "" && values.indexOf(value) === index);
}

function getBackfillFirstMessage(database: Database, chatId: string): ChatMessageBackfillRow | null {
  if (!sqliteTableExists(database, "chat_messages")) return null;
  const row = database
    .prepare(
      `
      SELECT id, provider_message_id, raw_sender_id, normalized_sender_id, provider_timestamp, ingested_at,
             raw_provenance_json
      FROM chat_messages
      WHERE chat_id = ?
        AND agent_id IS NULL
        AND (actor_type IS NULL OR actor_type <> 'agent')
      ORDER BY COALESCE(provider_timestamp, ingested_at), ingested_at, id
      LIMIT 1
    `,
    )
    .get(chatId) as ChatMessageBackfillRow | undefined;
  return row ?? null;
}

function cleanDisplayNameCandidate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (looksLikeRawPlatformIdentifier(trimmed)) return null;
  return trimmed;
}

function looksLikeRawPlatformIdentifier(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.includes("@")) return true;
  if (/^lid:/i.test(trimmed)) return true;
  if (/^\d{6,}$/.test(trimmed)) return true;
  return false;
}

function extractPushNameFromProvenance(provenanceJson: string | null): string | null {
  if (!provenanceJson) return null;
  const parsed = parseJsonObject(provenanceJson);
  if (!parsed) return null;
  const direct = cleanDisplayNameCandidate(parsed.pushName);
  if (direct) return direct;
  const rawPayload = parsed.rawPayload;
  if (rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload)) {
    const fromRaw = cleanDisplayNameCandidate((rawPayload as Record<string, unknown>).pushName);
    if (fromRaw) return fromRaw;
    const notify = cleanDisplayNameCandidate((rawPayload as Record<string, unknown>).notify);
    if (notify) return notify;
  }
  return null;
}

function getBackfillPushNameFromMessages(database: Database, chatId: string): string | null {
  if (!sqliteTableExists(database, "chat_messages")) return null;
  const rows = database
    .prepare(
      `
      SELECT raw_provenance_json
      FROM chat_messages
      WHERE chat_id = ?
        AND agent_id IS NULL
        AND (actor_type IS NULL OR actor_type <> 'agent')
        AND raw_provenance_json IS NOT NULL
      ORDER BY COALESCE(provider_timestamp, ingested_at), ingested_at, id
      LIMIT 25
    `,
    )
    .all(chatId) as Array<{ raw_provenance_json: string | null }>;
  for (const row of rows) {
    const name = extractPushNameFromProvenance(row.raw_provenance_json);
    if (name) return name;
  }
  return null;
}

function getBackfillParticipantDisplayName(
  database: Database,
  chatId: string,
  _senderCandidates: string[],
): string | null {
  if (!sqliteTableExists(database, "chat_participants")) return null;
  const rows = database
    .prepare(
      `
      SELECT metadata_json, source
      FROM chat_participants
      WHERE chat_id = ?
        AND agent_id IS NULL
        AND (role IS NULL OR role <> 'agent')
        AND metadata_json IS NOT NULL
      ORDER BY
        CASE WHEN source = 'inbound_message' THEN 0
             WHEN source = 'inbound_contact_backfill' THEN 2
             ELSE 1
        END,
        last_seen_at DESC,
        id
    `,
    )
    .all(chatId) as Array<{ metadata_json: string | null; source: string | null }>;
  for (const row of rows) {
    const parsed = parseJsonObject(row.metadata_json);
    if (!parsed) continue;
    const name = cleanDisplayNameCandidate(parsed.displayName);
    if (name) return name;
  }
  return null;
}

function resolveBackfillDisplayName(
  database: Database,
  chatId: string,
  fallbackTitle: string | null,
  senderCandidates: string[],
  message: ChatMessageBackfillRow | null,
): string | null {
  const fromMessage = extractPushNameFromProvenance(message?.raw_provenance_json ?? null);
  if (fromMessage) return fromMessage;
  const fromScan = getBackfillPushNameFromMessages(database, chatId);
  if (fromScan) return fromScan;
  const fromParticipants = getBackfillParticipantDisplayName(database, chatId, senderCandidates);
  if (fromParticipants) return fromParticipants;
  return cleanDisplayNameCandidate(fallbackTitle);
}

function findBackfillChatForPending(
  database: Database | null,
  pending: AccountPendingBackfillRow,
  channelFilter: string | null,
  chatInstanceIds: string[] = [],
): ChatBackfillRow | null {
  if (!database || !sqliteTableExists(database, "chats")) return null;
  const normalizedPhone = normalizePhone(pending.phone);
  const normalizedChat = pending.chat_id ? normalizePhone(pending.chat_id) : "";
  const candidates = [pending.chat_id ?? "", pending.phone, normalizedPhone, normalizedChat]
    .map((value) => value.trim())
    .filter((value, index, values) => value !== "" && values.indexOf(value) === index);
  if (candidates.length === 0) return null;
  const instanceCandidates = uniqueNonEmptyStrings([pending.account_id, ...chatInstanceIds]);
  const candidatePlaceholders = sqlPlaceholders(candidates);
  const instancePlaceholders = sqlPlaceholders(instanceCandidates);
  const where: string[] = ["chat_type = 'dm'"];
  const params: Array<string | number> = [];
  if (instanceCandidates.length > 0) {
    where.push(`instance_id IN (${instancePlaceholders})`);
    params.push(...instanceCandidates);
  }
  if (channelFilter) {
    where.push("channel = ?");
    params.push(channelFilter);
  }
  where.push(
    `(id IN (${candidatePlaceholders}) OR platform_chat_id IN (${candidatePlaceholders}) OR normalized_chat_id IN (${candidatePlaceholders}))`,
  );
  params.push(...candidates, ...candidates, ...candidates);
  const row = database
    .prepare(
      `
      SELECT * FROM chats
      WHERE ${where.join(" AND ")}
      ORDER BY last_seen_at DESC, updated_at DESC
      LIMIT 1
    `,
    )
    .get(...params) as ChatBackfillRow | undefined;
  return row ?? null;
}

function addBackfillCandidate(
  candidates: Map<string, InboundContactBackfillCandidate>,
  candidate: InboundContactBackfillCandidate,
): void {
  const existing = candidates.get(candidate.key);
  if (!existing) {
    candidates.set(candidate.key, candidate);
    return;
  }
  existing.sources = [...new Set([...existing.sources, ...candidate.sources])];
  existing.displayName ||= candidate.displayName;
  existing.avatarUrl ||= candidate.avatarUrl;
  existing.providerMessageId ||= candidate.providerMessageId;
  existing.chatId ||= candidate.chatId;
  existing.chatType ||= candidate.chatType;
  existing.provenance = {
    ...existing.provenance,
    mergedSources: existing.sources,
    extra: candidate.provenance,
  };
}

function candidateFromChatRow(database: Database, row: ChatBackfillRow): InboundContactBackfillCandidate | null {
  if (row.chat_type !== "dm") return null;
  const message = getBackfillFirstMessage(database, row.id);
  const contactIdentity = (message?.normalized_sender_id || row.normalized_chat_id || row.platform_chat_id).trim();
  const normalizedSenderId = normalizePhone(contactIdentity);
  const platformSenderId = (message?.raw_sender_id || row.platform_chat_id || contactIdentity).trim();
  const channel = normalizePlatformIdentityChannel(row.channel);
  const senderCandidates = backfillSenderCandidates({
    platformSenderId,
    normalizedSenderId,
    contactIdentity,
  });
  const displayName = resolveBackfillDisplayName(database, row.id, row.title, senderCandidates, message);
  const key = `chat:${row.id}`;
  return {
    key,
    sources: ["chats"],
    channel,
    instanceId: row.instance_id,
    chatId: row.id,
    chatType: row.chat_type,
    platformSenderId,
    normalizedSenderId,
    contactIdentity,
    displayName,
    avatarUrl: row.avatar_url,
    providerMessageId: message?.provider_message_id ?? null,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    provenance: {
      source: "chats",
      chatId: row.id,
      platformChatId: row.platform_chat_id,
      normalizedChatId: row.normalized_chat_id,
      rawProvenance: parseJsonObject(row.raw_provenance_json),
      firstMessageId: message?.id ?? null,
    },
  };
}

function candidateFromAccountPendingRow(
  database: Database | null,
  row: AccountPendingBackfillRow,
  channelFilter: string | null,
  chatInstanceIds: string[] = [],
): InboundContactBackfillCandidate | null {
  if (row.is_group === 1) return null;
  const chat = findBackfillChatForPending(database, row, channelFilter, chatInstanceIds);
  const message = chat ? getBackfillFirstMessage(database, chat.id) : null;
  const channel = normalizePlatformIdentityChannel(chat?.channel ?? channelFilter ?? "whatsapp");
  const contactIdentity = (message?.normalized_sender_id || normalizePhone(row.phone) || row.phone).trim();
  const normalizedSenderId = normalizePhone(contactIdentity);
  const platformSenderId = (message?.raw_sender_id || chat?.platform_chat_id || row.phone).trim();
  const key = chat?.id ? `chat:${chat.id}` : `pending:${row.account_id}:${normalizedSenderId || contactIdentity}`;
  const senderCandidates = backfillSenderCandidates({
    platformSenderId,
    normalizedSenderId,
    contactIdentity,
  });
  const displayName =
    cleanDisplayNameCandidate(row.name) ??
    (database && chat ? resolveBackfillDisplayName(database, chat.id, chat.title, senderCandidates, message) : null);
  return {
    key,
    sources: ["account_pending"],
    channel,
    instanceId: chat?.instance_id ?? row.account_id,
    chatId: chat?.id ?? null,
    chatType: chat?.chat_type ?? "dm",
    platformSenderId,
    normalizedSenderId,
    contactIdentity,
    displayName,
    avatarUrl: chat?.avatar_url ?? null,
    providerMessageId: message?.provider_message_id ?? null,
    firstSeenAt: chat?.first_seen_at ?? row.created_at,
    lastSeenAt: chat?.last_seen_at ?? row.updated_at,
    provenance: {
      source: "account_pending",
      accountId: row.account_id,
      phone: row.phone,
      chatId: row.chat_id,
      canonicalChatId: chat?.id ?? null,
      firstMessageId: message?.id ?? null,
    },
  };
}

function listInboundContactBackfillCandidates(
  contactDatabase: Database,
  chatDatabase: Database | null,
  input: BackfillInboundContactsInput,
  instanceFilter: BackfillInstanceFilter,
): InboundContactBackfillCandidate[] {
  const channelFilter = input.channel ? normalizePlatformIdentityChannel(input.channel) : null;
  const candidates = new Map<string, InboundContactBackfillCandidate>();

  if (chatDatabase && sqliteTableExists(chatDatabase, "chats")) {
    const where: string[] = ["chat_type = 'dm'"];
    const params: Array<string | number> = [];
    if (channelFilter) {
      where.push("channel = ?");
      params.push(channelFilter);
    }
    if (instanceFilter.chatInstanceIds.length > 0) {
      where.push(`instance_id IN (${sqlPlaceholders(instanceFilter.chatInstanceIds)})`);
      params.push(...instanceFilter.chatInstanceIds);
    }
    const rows = chatDatabase
      .prepare(
        `
        SELECT * FROM chats
        WHERE ${where.join(" AND ")}
        ORDER BY last_seen_at DESC, updated_at DESC
      `,
      )
      .all(...params) as ChatBackfillRow[];
    for (const row of rows) {
      const candidate = candidateFromChatRow(chatDatabase, row);
      if (candidate) addBackfillCandidate(candidates, candidate);
    }
  }

  if (sqliteTableExists(contactDatabase, "account_pending")) {
    const where: string[] = ["is_group = 0"];
    const params: Array<string | number> = [];
    if (instanceFilter.accountIds.length > 0) {
      where.push(`account_id IN (${sqlPlaceholders(instanceFilter.accountIds)})`);
      params.push(...instanceFilter.accountIds);
    }
    const rows = contactDatabase
      .prepare(
        `
        SELECT * FROM account_pending
        WHERE ${where.join(" AND ")}
        ORDER BY updated_at DESC
      `,
      )
      .all(...params) as AccountPendingBackfillRow[];
    for (const row of rows) {
      const candidate = candidateFromAccountPendingRow(
        chatDatabase,
        row,
        channelFilter,
        instanceFilter.chatInstanceIds,
      );
      if (candidate) addBackfillCandidate(candidates, candidate);
    }
  }

  const limit = normalizeBackfillLimit(input.limit);
  const all = [...candidates.values()];
  return limit ? all.slice(0, limit) : all;
}

function inspectInboundContactBackfillCandidate(
  database: Database,
  candidate: InboundContactBackfillCandidate,
): Pick<InboundContactBackfillItem, "action" | "skipReason" | "contactId" | "platformIdentityId"> {
  const contactIdentity = normalizePhone(candidate.contactIdentity);
  if (!candidate.channel) {
    return { action: "skipped", skipReason: "missing_channel", contactId: null, platformIdentityId: null };
  }
  if (!contactIdentity) {
    return { action: "skipped", skipReason: "missing_contact_identity", contactId: null, platformIdentityId: null };
  }
  if (contactIdentity.startsWith("group:")) {
    return { action: "skipped", skipReason: "chat_or_group_identity", contactId: null, platformIdentityId: null };
  }
  if (candidate.chatType && candidate.chatType !== "dm") {
    return { action: "skipped", skipReason: "not_a_dm", contactId: null, platformIdentityId: null };
  }

  const existingIdentity = findPlatformIdentityByChannelRef(database, {
    channel: candidate.channel,
    instanceId: candidate.instanceId,
    platformUserId: candidate.platformSenderId,
  });
  if (existingIdentity?.owner_type === "agent") {
    return {
      action: "skipped",
      skipReason: "agent_owned_identity",
      contactId: null,
      platformIdentityId: existingIdentity.id,
    };
  }

  const identityContact =
    existingIdentity?.owner_type === "contact" && existingIdentity.owner_id
      ? getCanonicalCompatContactById(database, existingIdentity.owner_id)
      : null;
  if (identityContact) {
    return {
      action: "already_linked",
      skipReason: null,
      contactId: identityContact.id,
      platformIdentityId: existingIdentity?.id ?? null,
    };
  }

  const contact = findCanonicalContactByIdentity(database, contactIdentity);
  if (contact) {
    return { action: "link_existing", skipReason: null, contactId: contact.id, platformIdentityId: null };
  }

  return { action: "create_contact", skipReason: null, contactId: null, platformIdentityId: null };
}

function updateBackfilledChatMessages(
  database: Database,
  candidate: InboundContactBackfillCandidate,
  contactId: string,
  platformIdentityId: string | null,
): number {
  if (!candidate.chatId || !sqliteTableExists(database, "chat_messages")) return 0;
  const senderCandidates = backfillSenderCandidates(candidate);
  const placeholders = senderCandidates.map(() => "?").join(", ");
  const now = Date.now();
  const result = database
    .prepare(
      `
      UPDATE chat_messages
      SET actor_type = 'contact',
          contact_id = ?,
          platform_identity_id = COALESCE(platform_identity_id, ?),
          raw_sender_id = COALESCE(raw_sender_id, ?),
          normalized_sender_id = COALESCE(normalized_sender_id, ?),
          updated_at = ?
      WHERE chat_id = ?
        AND agent_id IS NULL
        AND (actor_type IS NULL OR actor_type <> 'agent')
        AND (contact_id IS NULL OR contact_id = ?)
        AND (platform_identity_id IS NULL OR platform_identity_id = ?)
        AND (
          normalized_sender_id IS NULL
          OR normalized_sender_id IN (${placeholders})
          OR raw_sender_id IN (${placeholders})
        )
    `,
    )
    .run(
      contactId,
      platformIdentityId,
      candidate.platformSenderId,
      candidate.normalizedSenderId,
      now,
      candidate.chatId,
      contactId,
      platformIdentityId,
      ...senderCandidates,
      ...senderCandidates,
    );
  return result.changes;
}

function upsertBackfilledChatParticipant(
  database: Database,
  candidate: InboundContactBackfillCandidate,
  contactId: string,
  platformIdentityId: string | null,
): number {
  if (!candidate.chatId || !sqliteTableExists(database, "chat_participants")) return 0;
  const senderCandidates = backfillSenderCandidates(candidate);
  const placeholders = senderCandidates.map(() => "?").join(", ");
  const matches = database
    .prepare(
      `
      SELECT id, metadata_json FROM chat_participants
      WHERE chat_id = ?
        AND agent_id IS NULL
        AND (
          contact_id = ?
          OR platform_identity_id = ?
          OR normalized_platform_user_id IN (${placeholders})
        )
      ORDER BY
        CASE
          WHEN contact_id = ? THEN 0
          WHEN platform_identity_id = ? THEN 1
          ELSE 2
        END,
        last_seen_at DESC,
        id
    `,
    )
    .all(candidate.chatId, contactId, platformIdentityId, ...senderCandidates, contactId, platformIdentityId) as Array<{
    id: string;
    metadata_json: string | null;
  }>;
  const targetId =
    matches[0]?.id ?? stableId("cp", [candidate.chatId, platformIdentityId ?? contactId, candidate.normalizedSenderId]);
  const duplicateIds = matches.slice(1).map((row) => row.id);
  if (duplicateIds.length > 0) {
    const duplicatePlaceholders = duplicateIds.map(() => "?").join(", ");
    database.prepare(`DELETE FROM chat_participants WHERE id IN (${duplicatePlaceholders})`).run(...duplicateIds);
  }

  const previousMetadata = parseJsonObject(matches[0]?.metadata_json ?? null) ?? {};
  const metadata = {
    ...previousMetadata,
    backfill: {
      source: "inbound_contact_backfill",
      sources: candidate.sources,
      contactIdentity: candidate.contactIdentity,
      platformSenderId: candidate.platformSenderId,
    },
  };
  const now = Date.now();
  const firstSeenAt = candidate.firstSeenAt ?? now;
  const lastSeenAt = candidate.lastSeenAt ?? now;
  const result = database
    .prepare(
      `
      INSERT INTO chat_participants (
        id, chat_id, platform_identity_id, contact_id, agent_id,
        raw_platform_user_id, normalized_platform_user_id, role, status, source,
        first_seen_at, last_seen_at, metadata_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, NULL, ?, ?, 'member', 'active', 'inbound_contact_backfill', ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        platform_identity_id = COALESCE(excluded.platform_identity_id, chat_participants.platform_identity_id),
        contact_id = COALESCE(excluded.contact_id, chat_participants.contact_id),
        raw_platform_user_id = COALESCE(excluded.raw_platform_user_id, chat_participants.raw_platform_user_id),
        normalized_platform_user_id = COALESCE(excluded.normalized_platform_user_id, chat_participants.normalized_platform_user_id),
        role = CASE WHEN chat_participants.role = 'unknown' THEN excluded.role ELSE chat_participants.role END,
        status = 'active',
        source = excluded.source,
        first_seen_at = MIN(chat_participants.first_seen_at, excluded.first_seen_at),
        last_seen_at = MAX(chat_participants.last_seen_at, excluded.last_seen_at),
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `,
    )
    .run(
      targetId,
      candidate.chatId,
      platformIdentityId,
      contactId,
      candidate.platformSenderId,
      candidate.normalizedSenderId,
      firstSeenAt,
      lastSeenAt,
      jsonObject(metadata),
      now,
      now,
    );
  return result.changes;
}

function ensureBackfillReadingList(
  database: Database,
  name: string | null | undefined,
  ownerType?: string | null,
  ownerId?: string | null,
): { id: string; ownerType: string; ownerId: string } | null {
  const listName = name?.trim();
  if (!listName || !sqliteTableExists(database, "chat_reading_lists")) return null;
  const resolvedOwnerType = ownerType?.trim() || "agent";
  const resolvedOwnerId = ownerId?.trim() || "ravi-crm";
  const id = stableId("crl", [resolvedOwnerType, resolvedOwnerId, listName]);
  const now = Date.now();
  database
    .prepare(
      `
      INSERT INTO chat_reading_lists (
        id, name, description, owner_type, owner_id, visibility, mode, selector_json, metadata_json,
        created_at, updated_at, archived_at
      )
      VALUES (?, ?, 'Backfilled inbound contacts pending review', ?, ?, 'system', 'static', NULL, ?, ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET
        description = COALESCE(chat_reading_lists.description, excluded.description),
        updated_at = excluded.updated_at
    `,
    )
    .run(
      id,
      listName,
      resolvedOwnerType,
      resolvedOwnerId,
      metadataJson({ source: "inbound_contact_backfill" }),
      now,
      now,
    );
  return { id, ownerType: resolvedOwnerType, ownerId: resolvedOwnerId };
}

function addBackfilledChatToReadingList(database: Database, listId: string | null, chatId: string | null): boolean {
  if (!listId || !chatId || !sqliteTableExists(database, "chat_reading_list_members")) return false;
  const existing = database
    .prepare("SELECT id FROM chat_reading_list_members WHERE list_id = ? AND chat_id = ? AND removed_at IS NULL")
    .get(listId, chatId);
  if (existing) return false;
  const now = Date.now();
  database
    .prepare(
      `
      INSERT INTO chat_reading_list_members (
        id, list_id, chat_id, source, reason, priority, metadata_json, added_at, removed_at
      )
      VALUES (?, ?, ?, 'migration', 'inbound_contact_backfill', 0, ?, ?, NULL)
    `,
    )
    .run(`crlm_${generateId()}`, listId, chatId, metadataJson({ source: "inbound_contact_backfill" }), now);
  return true;
}

export function backfillInboundContacts(input: BackfillInboundContactsInput = {}): BackfillInboundContactsResult {
  const contactDatabase = ensureDb();
  const chatDatabase = openBackfillRouterDb();
  const mode = normalizeBackfillMode(input.mode);
  const apply = input.apply === true;
  const instanceFilter = resolveBackfillInstanceFilter(chatDatabase, input.instanceId);
  const readingList = ensureBackfillReadingList(
    chatDatabase ?? contactDatabase,
    apply ? input.createReadingList : null,
    input.readingListOwnerType,
    input.readingListOwnerId,
  );
  const candidates = listInboundContactBackfillCandidates(contactDatabase, chatDatabase, input, instanceFilter);
  const items: InboundContactBackfillItem[] = [];
  const totals: BackfillInboundContactsResult["totals"] = {
    candidates: candidates.length,
    eligible: 0,
    skipped: 0,
    contactsCreated: 0,
    contactsLinked: 0,
    platformIdentitiesCreated: 0,
    messagesUpdated: 0,
    participantsUpdated: 0,
    readingListMembersAdded: 0,
  };

  try {
    for (const candidate of candidates) {
      const inspected = inspectInboundContactBackfillCandidate(contactDatabase, candidate);
      let item: InboundContactBackfillItem = {
        key: candidate.key,
        sources: candidate.sources,
        action: inspected.action,
        skipReason: inspected.skipReason,
        channel: candidate.channel,
        instanceId: candidate.instanceId,
        chatId: candidate.chatId,
        chatType: candidate.chatType,
        platformSenderId: candidate.platformSenderId,
        normalizedSenderId: candidate.normalizedSenderId,
        contactIdentity: candidate.contactIdentity,
        displayName: candidate.displayName,
        contactId: inspected.contactId,
        platformIdentityId: inspected.platformIdentityId,
        createdContact: false,
        createdPlatformIdentity: false,
        messagesUpdated: 0,
        participantsUpdated: 0,
        readingListMemberAdded: false,
      };

      if (inspected.action === "skipped") {
        totals.skipped += 1;
        items.push(item);
        continue;
      }

      totals.eligible += 1;
      if (apply) {
        const intake = ensureContactFromInbound({
          channel: candidate.channel,
          instanceId: candidate.instanceId,
          platformSenderId: candidate.platformSenderId,
          contactIdentity: candidate.contactIdentity,
          displayName: candidate.displayName,
          avatarUrl: candidate.avatarUrl,
          chatId: candidate.chatId,
          chatType: candidate.chatType,
          providerMessageId: candidate.providerMessageId,
          sourceEventId: `backfill:${candidate.key}`,
          intakeMode: mode,
          source: "inbound_contact_backfill",
          defaultTags: instanceFilter.defaultContactTags.length > 0 ? instanceFilter.defaultContactTags : null,
          provenance: {
            ...candidate.provenance,
            sources: candidate.sources,
            mode,
          },
        });

        if (!intake.contact) {
          item = { ...item, action: "skipped", skipReason: "contact_not_resolved" };
          totals.skipped += 1;
          totals.eligible -= 1;
          items.push(item);
          continue;
        }

        if (
          candidate.displayName &&
          intake.contact.name &&
          looksLikeRawPlatformIdentifier(intake.contact.name) &&
          !looksLikeRawPlatformIdentifier(candidate.displayName)
        ) {
          upsertCanonicalContactRecord(contactDatabase, {
            id: intake.contact.id,
            displayName: candidate.displayName,
            coalesceDisplayName: false,
          });
          intake.contact = getCanonicalCompatContactById(contactDatabase, intake.contact.id) ?? intake.contact;
        }

        const platformIdentityId = intake.platformIdentity?.ownerType === "contact" ? intake.platformIdentity.id : null;
        const messagesUpdated = chatDatabase
          ? updateBackfilledChatMessages(chatDatabase, candidate, intake.contact.id, platformIdentityId)
          : 0;
        const participantsUpdated = chatDatabase
          ? upsertBackfilledChatParticipant(chatDatabase, candidate, intake.contact.id, platformIdentityId)
          : 0;
        const readingListMemberAdded = chatDatabase
          ? addBackfilledChatToReadingList(chatDatabase, readingList?.id ?? null, candidate.chatId)
          : false;

        item = {
          ...item,
          contactId: intake.contact.id,
          platformIdentityId,
          createdContact: intake.createdContact,
          createdPlatformIdentity: intake.createdPlatformIdentity,
          messagesUpdated,
          participantsUpdated,
          readingListMemberAdded,
        };
        if (intake.createdContact) totals.contactsCreated += 1;
        else totals.contactsLinked += 1;
        if (intake.createdPlatformIdentity) totals.platformIdentitiesCreated += 1;
        totals.messagesUpdated += messagesUpdated;
        totals.participantsUpdated += participantsUpdated;
        if (readingListMemberAdded) totals.readingListMembersAdded += 1;
      }

      items.push(item);
    }
  } finally {
    chatDatabase?.close();
  }

  return {
    dryRun: !apply,
    applied: apply,
    mode,
    filter: {
      instanceId: instanceFilter.requested,
      resolvedInstanceName: instanceFilter.resolvedInstanceName,
      resolvedInstanceId: instanceFilter.resolvedInstanceId,
      chatInstanceIds: instanceFilter.chatInstanceIds,
      accountIds: instanceFilter.accountIds,
      channel: input.channel ? normalizePlatformIdentityChannel(input.channel) : null,
    },
    readingList: {
      requestedName: input.createReadingList?.trim() || null,
      id: readingList?.id ?? null,
      ownerType: readingList?.ownerType ?? null,
      ownerId: readingList?.ownerId ?? null,
    },
    totals,
    items,
  };
}

export function setContactKind(contactRef: string, kind: "person" | "org"): ContactDetails {
  const database = ensureDb();
  const contactId = resolveCanonicalContactId(database, contactRef);
  if (!contactId) throw new Error(`Contact not found: ${contactRef}`);
  const previous = getCanonicalContactById(database, contactId);
  database.prepare("UPDATE contacts SET kind = ?, updated_at = datetime('now') WHERE id = ?").run(kind, contactId);
  if (previous?.kind !== kind) {
    insertContactEvent(database, {
      contactId,
      eventType: "profile.kind_changed",
      source: "contacts",
      actorType: "system",
      confidence: 1,
      payload: { previousKind: previous?.kind ?? null, kind },
    });
  }
  const details = getContactDetails(contactId);
  if (!details) throw new Error(`Contact is not canonical: ${contactId}`);
  return details;
}

/** Detect platform from a normalized identity value */
function detectPlatform(identity: string): string {
  if (identity.startsWith("lid:")) return "whatsapp";
  if (identity.startsWith("group:")) return "whatsapp_group";
  return "phone";
}

/** Resolve any identity string to a Contact (or null). Canonical tables are the runtime source of truth. */
function resolveContact(identity: string): Contact | null {
  return findCanonicalContactByIdentity(ensureDb(), identity);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Get a contact by any canonical contact id or platform identity.
 */
export function getContact(phone: string): Contact | null {
  return resolveContact(phone);
}

/**
 * Get a contact by its v2 UUID
 */
export function getContactById(id: string): Contact | null {
  return getCanonicalCompatContactById(ensureDb(), id);
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
  const database = ensureDb();
  const rows = database
    .prepare(
      `
      SELECT c.* FROM contacts c
      LEFT JOIN contact_policies cp ON cp.contact_id = c.id
      ORDER BY ${CANONICAL_CONTACT_RECENCY_ORDER_SQL}
    `,
    )
    .all() as CanonicalContactRow[];
  return rows.map((row) => rowToCanonicalCompatContact(database, row));
}

/**
 * Get contacts by status
 */
export function getContactsByStatus(status: ContactStatus): Contact[] {
  const database = ensureDb();
  const rows = database
    .prepare(
      `
      SELECT c.* FROM contacts c
      JOIN contact_policies cp ON cp.contact_id = c.id
      WHERE cp.status = ?
      ORDER BY ${CANONICAL_CONTACT_RECENCY_ORDER_SQL}
    `,
    )
    .all(status) as CanonicalContactRow[];
  return rows.map((row) => rowToCanonicalCompatContact(database, row));
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
  const normalized = assertPersonOrOrgIdentity(phone, "upsertContact");
  const existing = resolveContact(normalized);

  if (existing) {
    upsertCanonicalContactRecord(database, {
      id: existing.id,
      displayName: name ?? null,
      coalesceDisplayName: true,
    });
    upsertCanonicalContactPolicy(database, {
      contactId: existing.id,
      status,
      source: source ?? null,
    });
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
    const contact = createCanonicalContactForIdentity(database, normalized, {
      name,
      status,
      source,
    });
    const platform = detectPlatform(normalized);
    insertContactEvent(database, {
      contactId: contact.id,
      eventType: "profile.created",
      source: source ?? "contacts",
      actorType: "system",
      confidence: 1,
      payload: { identity: normalized, platform, name: name ?? null, status },
    });
    insertContactEvent(database, {
      contactId: contact.id,
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
  const normalized = assertPersonOrOrgIdentity(phone, "savePendingContact");
  const existing = resolveContact(normalized);

  if (existing) {
    if (name) {
      upsertCanonicalContactRecord(database, {
        id: existing.id,
        displayName: name,
        coalesceDisplayName: true,
      });
    }
    return false;
  } else {
    const contact = createCanonicalContactForIdentity(database, normalized, {
      name,
      status: "pending",
      source: "inbound",
    });
    const platform = detectPlatform(normalized);
    insertContactEvent(database, {
      contactId: contact.id,
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
  const contact = resolveContact(phone);
  if (!contact) return false;
  executeWrite(
    database,
    () => {
      if (getCanonicalContactById(database, contact.id)) {
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
      }
      deleteContactProjection(database, contact.id);
    },
    { label: "contacts:deleteContact" },
  );
  return true;
}

/**
 * Set contact status and optionally agent
 */
export function setContactStatus(phone: string, status: ContactStatus): void {
  const database = ensureDb();
  const normalized = assertPersonOrOrgIdentity(phone, "setContactStatus");
  const contact = resolveContact(normalized);
  if (!contact) {
    upsertContact(normalized, null, status);
  } else {
    upsertCanonicalContactPolicy(database, {
      contactId: contact.id,
      status,
    });
    if (contact.status !== status) {
      insertContactEvent(database, {
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
  const database = ensureDb();
  const contact = resolveContact(phone);
  if (contact) {
    upsertCanonicalContactPolicy(database, {
      contactId: contact.id,
      replyMode: mode,
    });
    if (contact.reply_mode !== mode) {
      insertContactEvent(database, {
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
  const normalized = assertPersonOrOrgIdentity(phone, "saveDiscoveredContact");
  const existing = resolveContact(normalized);

  if (existing) {
    if (name) {
      upsertCanonicalContactRecord(database, {
        id: existing.id,
        displayName: name,
        coalesceDisplayName: true,
      });
    }
  } else {
    const contact = createCanonicalContactForIdentity(database, normalized, {
      name,
      status: "discovered",
      source: "discovered",
    });
    const platform = detectPlatform(normalized);
    insertContactEvent(database, {
      contactId: contact.id,
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
  const normalized = assertPersonOrOrgIdentity(input.phone, "createContact");
  const existing = resolveContact(normalized);
  if (existing) {
    throw new Error(`Contact already exists: ${normalized}`);
  }

  const contact = createCanonicalContactForIdentity(database, normalized, {
    name: input.name ?? null,
    email: input.email ?? null,
    status: input.status ?? "allowed",
    source: input.source ?? null,
    tags: input.tags ?? [],
    notes: input.notes ?? {},
  });
  const platform = detectPlatform(normalized);
  insertContactEvent(database, {
    contactId: contact.id,
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
  return getContactById(contact.id)!;
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

  if (
    updates.name === undefined &&
    updates.email === undefined &&
    updates.status === undefined &&
    updates.reply_mode === undefined &&
    updates.tags === undefined &&
    updates.notes === undefined &&
    updates.opt_out === undefined &&
    updates.source === undefined &&
    updates.allowedAgents === undefined
  ) {
    return contact;
  }

  if (updates.name !== undefined || updates.email !== undefined) {
    database
      .prepare(
        `
        UPDATE contacts
        SET display_name = CASE WHEN ? = 1 THEN ? ELSE display_name END,
            primary_email = CASE WHEN ? = 1 THEN ? ELSE primary_email END,
            updated_at = datetime('now')
        WHERE id = ?
      `,
      )
      .run(
        updates.name !== undefined ? 1 : 0,
        updates.name ?? null,
        updates.email !== undefined ? 1 : 0,
        updates.email ?? null,
        contact.id,
      );
  }

  upsertCanonicalContactPolicy(database, {
    contactId: contact.id,
    status: updates.status,
    replyMode: updates.reply_mode,
    tags: updates.tags,
    notes: updates.notes,
    optOut: updates.opt_out,
    source: updates.source,
    allowedAgents: updates.allowedAgents,
  });
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
  const database = ensureDb();
  const contactsById = new Map<string, Contact>();

  const normalizedSlug = normalizeCanonicalTagSlug(tag);
  const tagsToFind = [...new Set([tag, normalizedSlug].filter((value): value is string => Boolean(value)))];
  for (const tagValue of tagsToFind) {
    const rows = database
      .prepare(
        `
        SELECT c.* FROM contacts c
        JOIN contact_policies cp ON cp.contact_id = c.id
        JOIN json_each(COALESCE(cp.tags_json, '[]')) AS t
        WHERE t.value = ?
        ORDER BY c.display_name, c.id
      `,
      )
      .all(tagValue) as CanonicalContactRow[];
    for (const row of rows) {
      const contact = rowToCanonicalCompatContact(database, row);
      contactsById.set(contact.id, contact);
    }
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
  const database = ensureDb();
  const pattern = `%${query}%`;
  const rows = database
    .prepare(
      `
      SELECT DISTINCT c.* FROM contacts c
      LEFT JOIN platform_identities pi ON pi.owner_type = 'contact' AND pi.owner_id = c.id
      WHERE c.display_name LIKE ?
         OR c.primary_email LIKE ?
         OR c.primary_phone LIKE ?
         OR pi.platform_user_id LIKE ?
         OR pi.normalized_platform_user_id LIKE ?
      ORDER BY c.display_name, c.id
    `,
    )
    .all(pattern, pattern, pattern, pattern, pattern) as CanonicalContactRow[];
  return rows.map((row) => rowToCanonicalCompatContact(database, row));
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
  upsertCanonicalContactPolicy(database, {
    contactId: contact.id,
    notes: merged,
  });
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
  const tags = mergeTagLists(contact.tags, [canonicalSlug]);
  upsertCanonicalContactPolicy(database, {
    contactId: contact.id,
    tags,
  });
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

  const canonicalSlug = normalizeCanonicalTagSlug(tag);
  const tags = contact.tags.filter((t) => !canonicalSlug || normalizeCanonicalTagSlug(t) !== canonicalSlug);
  if (canonicalSlug) {
    detachTagFromSelector({
      slug: canonicalSlug,
      selector: { target: `contact:${contact.id}` },
      source: "contacts.removeContactTag",
      actor: "contacts",
    });
  }
  upsertCanonicalContactPolicy(database, {
    contactId: contact.id,
    tags,
  });
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
  const database = ensureDb();
  const contact = resolveContact(phone);
  if (contact) {
    database
      .prepare(
        `
        UPDATE contact_policies
        SET last_inbound_at = datetime('now'),
            interaction_count = interaction_count + 1,
            updated_at = datetime('now')
        WHERE contact_id = ?
      `,
      )
      .run(contact.id);
  }
}

/**
 * Record an outbound message to a contact
 */
export function recordOutbound(phone: string): void {
  const database = ensureDb();
  const contact = resolveContact(phone);
  if (contact) {
    database
      .prepare(
        `
        UPDATE contact_policies
        SET last_outbound_at = datetime('now'),
            interaction_count = interaction_count + 1,
            updated_at = datetime('now')
        WHERE contact_id = ?
      `,
      )
      .run(contact.id);
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
    upsertCanonicalContactPolicy(database, {
      contactId: contact.id,
      optOut,
    });
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
// Identity management
// ============================================================================

/**
 * Get all identities for a contact
 */
export function getContactIdentities(contactId: string): ContactIdentity[] {
  return getCanonicalCompatIdentities(ensureDb(), contactId);
}

function mapLinkInput(
  channel: string,
  value: string,
): {
  inputPlatform: string;
  inputValue: string;
  canonicalChannel: string;
  normalizedValue: string;
} {
  const normalizedChannel = normalizePlatformIdentityChannel(channel);
  if (!normalizedChannel) throw new Error("Channel is required");

  if (normalizedChannel === "whatsapp_group" || contactIdentityIsGroup(normalizedChannel, value)) {
    throw new Error("Group/chat identities belong to chats, not contacts");
  }

  if (normalizedChannel === "whatsapp") {
    const normalized = normalizePhone(value);
    if (normalized.startsWith("group:")) {
      throw new Error("Group/chat identities belong to chats, not contacts");
    }
    if (normalized.startsWith("lid:")) {
      return {
        inputPlatform: "whatsapp",
        inputValue: normalized,
        canonicalChannel: "whatsapp",
        normalizedValue: normalized,
      };
    }
    return {
      inputPlatform: "phone",
      inputValue: normalized,
      canonicalChannel: "phone",
      normalizedValue: normalized,
    };
  }

  if (normalizedChannel === "phone") {
    const normalized = normalizePhone(value);
    return {
      inputPlatform: "phone",
      inputValue: normalized,
      canonicalChannel: "phone",
      normalizedValue: normalized,
    };
  }

  if (normalizedChannel === "email") {
    const normalized = normalizeIdentityForChannel("email", value);
    return {
      inputPlatform: "email",
      inputValue: normalized,
      canonicalChannel: "email",
      normalizedValue: normalized,
    };
  }

  return {
    inputPlatform: normalizedChannel,
    inputValue: normalizeIdentityForChannel(normalizedChannel, value),
    canonicalChannel: normalizedChannel,
    normalizedValue: normalizeIdentityForChannel(normalizedChannel, value),
  };
}

function upsertCanonicalPlatformIdentity(
  database: Database,
  contactId: string,
  mapped: {
    inputPlatform: string;
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
        inputPlatform: mapped.inputPlatform,
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
  const target = getContactById(targetId);
  const source = getContactById(sourceId);
  if (!target) throw new Error(`Target contact not found: ${targetId}`);
  if (!source) throw new Error(`Source contact not found: ${sourceId}`);

  const sourceIdentities = getCanonicalCompatIdentities(database, sourceId);
  let movedCanonicalIdentityIds: string[] = [];

  executeWrite(
    database,
    () => {
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

      movedCanonicalIdentityIds = moveCanonicalPlatformIdentities(database, sourceId, targetId);
      moveCanonicalContactTagBindings(sourceId, targetId);
      mergeCrmContactData(database, sourceId, targetId);

      if (!target.name && source.name) {
        database
          .prepare("UPDATE contacts SET display_name = ?, updated_at = datetime('now') WHERE id = ?")
          .run(source.name, targetId);
      }
      if (!target.email && source.email) {
        database
          .prepare("UPDATE contacts SET primary_email = ?, updated_at = datetime('now') WHERE id = ?")
          .run(source.email, targetId);
      }
      const mergedTags = target.tags.length === 0 && source.tags.length > 0 ? source.tags : target.tags;
      const mergedNotes =
        Object.keys(target.notes).length === 0 && Object.keys(source.notes).length > 0 ? source.notes : target.notes;
      if (target.tags.length === 0 && source.tags.length > 0) {
        syncCanonicalContactTags(targetId, source.tags);
      }
      database
        .prepare(
          `
        UPDATE contact_policies
        SET tags_json = ?,
            notes_json = ?,
            interaction_count = interaction_count + ?,
            last_inbound_at = CASE
              WHEN last_inbound_at IS NULL THEN ?
              WHEN ? IS NULL THEN last_inbound_at
              WHEN ? > last_inbound_at THEN ?
              ELSE last_inbound_at
            END,
            last_outbound_at = CASE
              WHEN last_outbound_at IS NULL THEN ?
              WHEN ? IS NULL THEN last_outbound_at
              WHEN ? > last_outbound_at THEN ?
              ELSE last_outbound_at
            END,
            updated_at = datetime('now')
        WHERE contact_id = ?
      `,
        )
        .run(
          JSON.stringify(mergedTags),
          JSON.stringify(mergedNotes),
          source.interaction_count,
          source.last_inbound_at,
          source.last_inbound_at,
          source.last_inbound_at,
          source.last_inbound_at,
          source.last_outbound_at,
          source.last_outbound_at,
          source.last_outbound_at,
          source.last_outbound_at,
          targetId,
        );

      deleteContactProjection(database, sourceId);

      database
        .prepare(
          `
        INSERT OR IGNORE INTO identity_link_events (
          id, event_type, source_owner_type, source_owner_id, target_owner_type, target_owner_id,
          confidence, reason, actor_type, metadata_json
        )
        VALUES (?, 'merge', 'contact', ?, 'contact', ?, 1.0, 'contact_merge', 'system', ?)
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
    },
    { label: "contacts:mergeContacts" },
  );
  return { merged: sourceIdentities.length };
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
  }
}
