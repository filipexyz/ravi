---
id: contacts/crm
title: Contact CRM Schemas
kind: capability
domain: contacts
capability: crm
tags:
  - contacts
  - crm
  - accounts
  - opportunities
  - followups
  - timeline
applies_to:
  - src/contacts.ts
  - src/cli/commands/contacts.ts
  - src/router
owners:
  - ravi-dev
status: draft
normative: false
---

# Contact CRM Schemas

## Intent

CRM is the operational relationship layer above Ravi contacts.

It MUST NOT replace contact identity, contact policy, chats, sessions, messages, or platform identities. CRM state describes relationship work: lifecycle, accounts, opportunities, next actions, ownership, curated activity, and playbooks.

The public product language SHOULD stay centered on contacts, with CRM exposed as a higher-level surface:

```bash
ravi contacts profile <contact>
ravi crm next
ravi crm account <account>
ravi crm opportunity <opportunity>
```

## Boundaries

- `contact_policy.status` remains access control: `allowed`, `pending`, `blocked`, `discovered`.
- CRM lifecycle/status MUST be separate from policy status.
- A person or organization remains a canonical `contact`.
- A CRM account SHOULD wrap an organization contact (`contacts.kind='org'`) instead of becoming a separate identity source.
- A chat/group/thread remains a `chat`, never a contact or account.
- Messages and session events remain evidence. CRM activities are curated relationship events, not raw transport logs.
- Every CRM mutation MUST write an audit event with source, actor, confidence, and evidence.
- CRM current-state tables are projections. `crm_events` is the CRM append-only audit ledger.
- When a CRM event involves a contact, Ravi SHOULD also project a meaningful `contact_event` so contact timeline stays useful.
- Retried CRM create/write commands SHOULD accept `idempotency_key` and return the existing row/event when the same key was already applied.
- Non-null `idempotency_key` values MUST be protected by partial unique indexes on the table that stores them.
- Contact merges MUST move CRM projections, memberships, stakeholders, tasks, activities, participants, and facts from source contact to target contact before deleting the source projection.

## Enum Sets

These are stored as text values in SQLite.

### `crm_entity_kind`

- `contact`
- `account`
- `opportunity`
- `task`
- `activity`
- `segment`
- `playbook`

### `crm_owner_type`

- `user`
- `agent`
- `team`
- `system`

### `crm_contact_lifecycle`

- `unknown`
- `lead`
- `qualified`
- `active`
- `onboarding`
- `waiting`
- `at_risk`
- `dormant`
- `churned`
- `partner`
- `vendor`
- `internal`

### `crm_relationship_health`

- `unknown`
- `good`
- `neutral`
- `needs_attention`
- `at_risk`

### `crm_priority`

- `low`
- `normal`
- `high`
- `urgent`

### `crm_opportunity_status`

- `open`
- `won`
- `lost`
- `paused`
- `archived`

### `crm_task_status`

- `open`
- `scheduled`
- `waiting`
- `done`
- `canceled`
- `snoozed`

### `crm_activity_type`

- `message`
- `note`
- `call`
- `meeting`
- `task`
- `follow_up`
- `status_change`
- `opportunity_update`
- `profile_update`
- `handoff`
- `automation_decision`

### `crm_fact_status`

- `proposed`
- `confirmed`
- `rejected`
- `superseded`

## Core Tables

### `crm_events`

Append-only CRM audit ledger. This is the source of truth for why current CRM state changed.

```sql
CREATE TABLE IF NOT EXISTS crm_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
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
  confidence REAL NOT NULL DEFAULT 1.0,
  payload_json TEXT NOT NULL,
  previous_payload_json TEXT,
  evidence_json TEXT,

  created_at TEXT NOT NULL DEFAULT (datetime('now'))
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_events_idempotency_key
  ON crm_events(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```

Required event types:

- `crm.contact_profile.updated`
- `crm.contact.merged`
- `crm.account.created`
- `crm.account.updated`
- `crm.account_contact.linked`
- `crm.account_contact.unlinked`
- `crm.opportunity.created`
- `crm.opportunity_contact.linked`
- `crm.opportunity.stage_changed`
- `crm.opportunity.status_changed`
- `crm.task.created`
- `crm.task.completed`
- `crm.activity.logged`
- `crm.activity_participant.linked`
- `crm.fact.proposed`
- `crm.fact.confirmed`
- `crm.fact.rejected`
- `crm.fact.superseded`
- `crm.segment.member_added`
- `crm.playbook.run_started`
- `crm.playbook.run_finished`

### `crm_contact_profiles`

One current CRM projection per canonical person contact.

```sql
CREATE TABLE IF NOT EXISTS crm_contact_profiles (
  contact_id TEXT PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,

  lifecycle TEXT NOT NULL DEFAULT 'unknown',
  relationship_health TEXT NOT NULL DEFAULT 'unknown',
  priority TEXT NOT NULL DEFAULT 'normal',
  score REAL,
  health_score REAL,

  owner_type TEXT,
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
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_crm_contact_profiles_lifecycle
  ON crm_contact_profiles(lifecycle, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_crm_contact_profiles_owner
  ON crm_contact_profiles(owner_type, owner_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_crm_contact_profiles_next_action
  ON crm_contact_profiles(next_action_at)
  WHERE next_action_at IS NOT NULL;
```

Rules:

- `lifecycle` MUST NOT duplicate `contact_policy.status`.
- `last_meaningful_interaction_at` SHOULD be curated. Raw inbound count alone is not enough.
- `next_action_*` SHOULD point to `crm_tasks` when the action is actionable.

### `crm_accounts`

An account is the CRM wrapper for an organization. Its identity anchor is an org contact when known.

```sql
CREATE TABLE IF NOT EXISTS crm_accounts (
  id TEXT PRIMARY KEY,
  org_contact_id TEXT UNIQUE REFERENCES contacts(id) ON DELETE SET NULL,

  name TEXT NOT NULL,
  legal_name TEXT,
  domain TEXT,
  website_url TEXT,
  industry TEXT,
  size_label TEXT,
  lifecycle TEXT NOT NULL DEFAULT 'unknown',
  relationship_health TEXT NOT NULL DEFAULT 'unknown',
  priority TEXT NOT NULL DEFAULT 'normal',

  owner_type TEXT,
  owner_id TEXT,

  source TEXT NOT NULL DEFAULT 'manual',
  idempotency_key TEXT,
  confidence REAL NOT NULL DEFAULT 1.0,
  metadata_json TEXT NOT NULL DEFAULT '{}',

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_crm_accounts_name
  ON crm_accounts(name);

CREATE INDEX IF NOT EXISTS idx_crm_accounts_domain
  ON crm_accounts(domain)
  WHERE domain IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_crm_accounts_owner
  ON crm_accounts(owner_type, owner_id, updated_at DESC);
```

Rules:

- If `org_contact_id` is present, that contact MUST have `kind='org'`.
- The account table MUST NOT store channel identities. Organization channels still belong to `platform_identities`.
- `name` is a CRM display projection, not identity proof.

### `crm_account_contacts`

Connects people contacts to CRM accounts.

```sql
CREATE TABLE IF NOT EXISTS crm_account_contacts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES crm_accounts(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,

  role TEXT NOT NULL DEFAULT 'member',
  title TEXT,
  department TEXT,
  decision_role TEXT NOT NULL DEFAULT 'unknown',
  relationship_strength TEXT NOT NULL DEFAULT 'unknown',
  is_primary INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',

  source TEXT NOT NULL DEFAULT 'manual',
  idempotency_key TEXT,
  confidence REAL NOT NULL DEFAULT 1.0,
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
```

Common `decision_role` values:

- `decision_maker`
- `sponsor`
- `influencer`
- `operator`
- `technical`
- `billing`
- `legal`
- `unknown`

### `crm_pipelines`

Defines ordered stages for opportunities or other CRM workflows.

```sql
CREATE TABLE IF NOT EXISTS crm_pipelines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT 'opportunity',
  is_default INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_pipelines_default
  ON crm_pipelines(entity_type, is_default)
  WHERE is_default = 1;
```

### `crm_pipeline_stages`

```sql
CREATE TABLE IF NOT EXISTS crm_pipeline_stages (
  id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL REFERENCES crm_pipelines(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  category TEXT NOT NULL DEFAULT 'active',
  probability REAL,
  is_terminal INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(pipeline_id, key),
  UNIQUE(pipeline_id, sort_order)
);

CREATE INDEX IF NOT EXISTS idx_crm_pipeline_stages_pipeline
  ON crm_pipeline_stages(pipeline_id, sort_order);
```

Common `category` values:

- `new`
- `active`
- `waiting`
- `terminal_won`
- `terminal_lost`

### `crm_opportunities`

Represents a deal, project, sale, partnership, or high-value relationship thread.

```sql
CREATE TABLE IF NOT EXISTS crm_opportunities (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES crm_accounts(id) ON DELETE SET NULL,
  primary_contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,

  pipeline_id TEXT REFERENCES crm_pipelines(id) ON DELETE SET NULL,
  stage_id TEXT REFERENCES crm_pipeline_stages(id) ON DELETE SET NULL,

  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  priority TEXT NOT NULL DEFAULT 'normal',

  value_cents INTEGER,
  currency TEXT NOT NULL DEFAULT 'BRL',
  probability REAL,
  expected_close_at TEXT,
  closed_at TEXT,
  lost_reason TEXT,

  owner_type TEXT,
  owner_id TEXT,

  source TEXT NOT NULL DEFAULT 'manual',
  idempotency_key TEXT,
  confidence REAL NOT NULL DEFAULT 1.0,
  evidence_json TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_crm_opportunities_account
  ON crm_opportunities(account_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_crm_opportunities_contact
  ON crm_opportunities(primary_contact_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_crm_opportunities_stage
  ON crm_opportunities(pipeline_id, stage_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_crm_opportunities_owner
  ON crm_opportunities(owner_type, owner_id, status, updated_at DESC);
```

Rules:

- An opportunity SHOULD have at least one of `account_id` or `primary_contact_id`.
- Stage movement MUST write `crm.opportunity.stage_changed`.
- Status changes MUST write `crm.opportunity.status_changed`.

### `crm_opportunity_contacts`

Stakeholders attached to an opportunity.

```sql
CREATE TABLE IF NOT EXISTS crm_opportunity_contacts (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES crm_opportunities(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  account_id TEXT REFERENCES crm_accounts(id) ON DELETE SET NULL,

  role TEXT NOT NULL DEFAULT 'stakeholder',
  influence TEXT NOT NULL DEFAULT 'unknown',
  sentiment TEXT NOT NULL DEFAULT 'unknown',
  is_primary INTEGER NOT NULL DEFAULT 0,

  source TEXT NOT NULL DEFAULT 'manual',
  confidence REAL NOT NULL DEFAULT 1.0,
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
```

Common `role` values:

- `buyer`
- `decision_maker`
- `sponsor`
- `operator`
- `technical`
- `billing`
- `stakeholder`
- `blocker`

### `crm_tasks`

CRM follow-up and relationship tasks. These are not Ravi runtime tasks, but they may launch or reference one.

```sql
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
  status TEXT NOT NULL DEFAULT 'open',
  priority TEXT NOT NULL DEFAULT 'normal',

  due_at TEXT,
  snoozed_until TEXT,
  completed_at TEXT,
  canceled_at TEXT,

  owner_type TEXT,
  owner_id TEXT,
  created_by_type TEXT NOT NULL DEFAULT 'system',
  created_by_id TEXT,

  source TEXT NOT NULL DEFAULT 'manual',
  idempotency_key TEXT,
  confidence REAL NOT NULL DEFAULT 1.0,
  evidence_json TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',

  ravi_task_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
```

Common `task_type` values:

- `follow_up`
- `call`
- `message`
- `meeting`
- `research`
- `review`
- `wait`
- `check_in`
- `commitment`

Rules:

- Completing a task MUST write `crm.task.completed`.
- If a task creates a runtime Ravi task, `ravi_task_id` links to that runtime task.
- A task SHOULD have at least one target: contact, account, opportunity, chat, or session.

## Scheduled Commitments and Daily Digest

A **commitment** is a `crm_tasks` row created in response to a customer stating an intent with a date — for example, "vou comprar sexta-feira", "te aviso semana que vem", "passa na segunda pra confirmar". The agent that is reading the conversation captures the contact, the implied date, and the surrounding evidence, then writes a single durable task row. A daily cron reads these rows to notify operators when commitments come due.

The commitment + digest pattern MUST NOT degrade into one cron per commitment. The architecture is exactly **one sweep cron + N persisted task rows**. This is the canonical CRM pattern for time-anchored customer promises; doing otherwise scales linearly with customer count and creates orphan cron entries that survive task changes.

### Commitment Task Shape

A commitment MUST be persisted as a `crm_tasks` row with:

- `task_type = 'commitment'`
- `status = 'scheduled'` (open and awaiting due date)
- `due_at` = the absolute timestamp the customer mentioned, normalized to operator timezone
- `contact_id` = the contact who made the promise
- `chat_id`, `session_key`, and `message_id` (in `evidence_json`) tracing the source utterance
- `title` = short summary, e.g. "Compra prometida — kraft 60g"
- `body` = the verbatim quote plus normalized interpretation
- `confidence` = confidence (0.0–1.0) in the extraction
- `evidence_json` = list of `{ message_id, quote, extracted_phrase, extracted_date_iso }`
- `source` = identifier of the creator (e.g. `agent:<id>` or `user:<id>`)
- `created_by_type` and `created_by_id` according to whichever side wrote the row
- `idempotency_key` = hash of `(contact_id, normalized_due_at, phrase_fingerprint)` so repeated extractions of the same commitment do not create duplicates
- `metadata_json.commitment_kind` = optional finer label (`purchase | follow_up_request | callback | revisit`)

Vague follow-ups without a concrete date MUST NOT become commitments. If the customer says "te aviso quando puder" with no date, persist a `follow_up` task with `due_at = null` and `status = waiting` instead.

### Cancellation and Reschedule

When a new conversation invalidates an existing commitment, the writer MUST update the existing row rather than creating a new one:

- **Cancel** ("mudei de ideia", "não vou mais comprar") → `status = 'canceled'`, write `crm.task.canceled` with the canceling message in `evidence_json`.
- **Reschedule** ("vou só na semana que vem") → update `due_at`, push the old `due_at` into `metadata_json.history`, write `crm.task.snoozed` or `crm.task.rescheduled`.
- **Confirm** ("já fiz a compra", "fechei agora") → `status = 'done'`, `completed_at = now()`, optionally link to a `crm_opportunities.won` row.

Lookups for existing commitments MUST use the `idempotency_key` plus a same-contact filter so the writer can find the row deterministically.

### Daily Digest

Notification is centralized in a single sweep, not in per-task crons. The implementation MUST:

- Run on a small number of cron entries (typically one morning + one afternoon, or a single daily cron); cron frequency MAY be adjusted by operator preference but MUST NOT be one cron per task.
- Query the `crm_next_actions` view filtered by `task_type = 'commitment'` and `due_at` within the digest window (e.g. `[now, now + 24h]`).
- Group results by owner (operator) so each operator receives a single consolidated digest, not one notification per task.
- Deliver via the operator's configured channel(s): WhatsApp DM, inbox session, Pages dashboard link, or any combination.
- Mark digested tasks with a `metadata_json.last_digested_at = now()` so the next sweep does not double-notify within the same window. The digest MUST NOT mutate `status`.

The digest is a **read-only consumer** of `crm_tasks`. It MUST NOT mark tasks `done` or `canceled` — those state changes are the operator's responsibility (or, in automated flows, the same writer that created the row).

### Operator Resolution

When an operator addresses a commitment, the existing CRM lifecycle applies:

- `ravi crm task done <id>` closes the commitment, writes `crm.task.completed`.
- `ravi crm task cancel <id>` cancels it.
- `ravi crm task snooze <id> --until <ts>` reschedules.
- If the commitment converted into a sale, the operator SHOULD link it to a `crm_opportunities` row marked `won`, ensuring the value flows through the opportunity board.

### Invariants

- Commitments MUST be persistent rows in `crm_tasks`. They MUST NOT be implemented as standalone cron jobs.
- One commitment per `(contact_id, normalized_due_at, phrase_fingerprint)` — the `idempotency_key` enforces this.
- The digest sweep MUST be idempotent inside a window: re-running the same digest within the window MUST NOT duplicate notifications.
- A canceled commitment MUST NOT reappear in `crm_next_actions` (the view filters by `status IN ('open', 'scheduled', 'waiting', 'snoozed')`).
- All commitment mutations MUST emit `crm_events` so the timeline reconstructs the negotiation arc (created → snoozed → completed/canceled).

### `crm_activities`

Curated relationship activity. Raw messages remain in message/session storage; this table stores CRM-relevant activity entries.

```sql
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
  confidence REAL NOT NULL DEFAULT 1.0,
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
```

Rules:

- `crm_activities` MUST NOT ingest every message by default.
- It SHOULD store high-signal events: meetings, calls, summarized message exchanges, stage changes, commitments, objections, and follow-ups.
- If a CRM activity concerns a contact, it SHOULD have a matching or linked `contact_event`.

### `crm_activity_participants`

Allows one activity to involve multiple contacts/accounts and preserve their role in the curated CRM activity.

```sql
CREATE TABLE IF NOT EXISTS crm_activity_participants (
  id TEXT PRIMARY KEY,
  activity_id TEXT NOT NULL REFERENCES crm_activities(id) ON DELETE CASCADE,
  contact_id TEXT REFERENCES contacts(id) ON DELETE CASCADE,
  account_id TEXT REFERENCES crm_accounts(id) ON DELETE SET NULL,

  role TEXT NOT NULL DEFAULT 'participant',
  actor_type TEXT,
  actor_id TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  confidence REAL NOT NULL DEFAULT 1.0,
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
```

### `crm_facts`

Structured facts for contact, account, and opportunity intelligence. This is useful when facts need lifecycle, review, or cross-entity support beyond `contact_metadata`.

```sql
CREATE TABLE IF NOT EXISTS crm_facts (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  contact_id TEXT REFERENCES contacts(id) ON DELETE CASCADE,
  account_id TEXT REFERENCES crm_accounts(id) ON DELETE CASCADE,
  opportunity_id TEXT REFERENCES crm_opportunities(id) ON DELETE CASCADE,

  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  source TEXT NOT NULL DEFAULT 'manual',
  idempotency_key TEXT,
  confidence REAL NOT NULL DEFAULT 1.0,
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_facts_idempotency_key
  ON crm_facts(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```

Rules:

- Low-confidence agent discoveries SHOULD start as `proposed`.
- Operator-confirmed facts SHOULD become `confirmed`.
- Superseded facts MUST keep history instead of being overwritten silently.
- Confirmed contact facts MAY project into `contacts_meta`/contact metadata when the profile card needs fast reads.

### `crm_segments`

Saved static or dynamic lists.

```sql
CREATE TABLE IF NOT EXISTS crm_segments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  segment_type TEXT NOT NULL DEFAULT 'static',
  entity_type TEXT NOT NULL DEFAULT 'contact',
  filter_json TEXT,
  owner_type TEXT,
  owner_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_crm_segments_entity
  ON crm_segments(entity_type, status, updated_at DESC);
```

### `crm_segment_members`

```sql
CREATE TABLE IF NOT EXISTS crm_segment_members (
  segment_id TEXT NOT NULL REFERENCES crm_segments(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  added_by_type TEXT NOT NULL DEFAULT 'system',
  added_by_id TEXT,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(segment_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_crm_segment_members_entity
  ON crm_segment_members(entity_type, entity_id);
```

### `crm_playbooks`

Reusable relationship workflows. These describe what should happen; triggers/tasks execute it.

```sql
CREATE TABLE IF NOT EXISTS crm_playbooks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  target_entity_type TEXT NOT NULL DEFAULT 'contact',
  trigger_type TEXT NOT NULL DEFAULT 'manual',
  goal TEXT,
  steps_json TEXT NOT NULL DEFAULT '[]',
  owner_type TEXT,
  owner_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_crm_playbooks_target
  ON crm_playbooks(target_entity_type, status, updated_at DESC);
```

### `crm_playbook_runs`

```sql
CREATE TABLE IF NOT EXISTS crm_playbook_runs (
  id TEXT PRIMARY KEY,
  playbook_id TEXT NOT NULL REFERENCES crm_playbooks(id) ON DELETE CASCADE,
  target_entity_type TEXT NOT NULL,
  target_entity_id TEXT NOT NULL,

  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  account_id TEXT REFERENCES crm_accounts(id) ON DELETE SET NULL,
  opportunity_id TEXT REFERENCES crm_opportunities(id) ON DELETE SET NULL,

  status TEXT NOT NULL DEFAULT 'running',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  result_json TEXT,
  error TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_crm_playbook_runs_target
  ON crm_playbook_runs(target_entity_type, target_entity_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_crm_playbook_runs_playbook
  ON crm_playbook_runs(playbook_id, started_at DESC);
```

## Views

### `crm_contact_cards`

Operator-facing row for dashboards.

```sql
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
```

### `crm_next_actions`

```sql
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
```

### `crm_opportunity_board`

```sql
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
```

### `crm_account_cards`

```sql
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
  COUNT(DISTINCT ac.contact_id) AS contact_count,
  COUNT(DISTINCT CASE WHEN o.status = 'open' THEN o.id END) AS open_opportunity_count,
  SUM(CASE WHEN o.status = 'open' THEN COALESCE(o.value_cents, 0) ELSE 0 END) AS open_value_cents,
  a.updated_at
FROM crm_accounts a
LEFT JOIN crm_account_contacts ac ON ac.account_id = a.id
LEFT JOIN crm_opportunities o ON o.account_id = a.id
GROUP BY a.id;
```

## Profile Metadata Projection

CRM SHOULD keep these current profile keys in contact metadata for fast profile-card reads:

- `crm.lifecycle`
- `crm.relationship_health`
- `crm.priority`
- `crm.owner`
- `crm.primary_account`
- `crm.primary_opportunity`
- `crm.next_action`
- `crm.open_loops`
- `crm.important_facts`

Rules:

- Metadata projection is cache/read-model behavior.
- The corresponding CRM table row and `crm_events` entry remain authoritative.
- Scoped CRM metadata MUST use explicit scope: `account`, `opportunity`, `project`, `chat`, `session`, `agent`, `domain`, or `task`.

## MVP Approval Slice

If approved incrementally, implement these first:

1. `crm_events`
2. `crm_contact_profiles`
3. `crm_accounts`
4. `crm_account_contacts`
5. `crm_opportunities`
6. `crm_tasks`
7. Views: `crm_contact_cards`, `crm_next_actions`, `crm_opportunity_board`

Defer until needed:

- `crm_facts`
- `crm_segments`
- `crm_playbooks`
- `crm_playbook_runs`
- `crm_activity_participants`

## CLI Surface

Initial commands:

```bash
ravi crm next [--json]
ravi crm contacts [--status <lifecycle>] [--owner <owner>] [--json]
ravi crm contact <contact> [--json]
ravi crm contact set <contact> <field> <value>
ravi crm account create <name> [--contact <org_contact_id>] [--json]
ravi crm account <account> [--json]
ravi crm account link-contact <account> <contact> [--role <role>]
ravi crm opportunity create <title> [--account <account>] [--contact <contact>]
ravi crm opportunity move <opportunity> <stage>
ravi crm task create <title> [--contact <contact>] [--account <account>] [--opportunity <opportunity>] [--due <date>]
ravi crm task done <task>
```

Contact profile integration:

```bash
ravi contacts profile <contact> --include-crm --json
```

## Tag-Driven Observer Orchestration

Contact tags double as the orchestration channel between intake, CRM workers, and observers.

- Instances MAY declare `default_contact_tags` so every newly captured contact lands in a known state (see `contacts/identity-graph/inbound-contact-intake`).
- Observer rules MAY target those tags with `--scope tag --tag-target contact --tag <slug>` so the right observer is attached as soon as a session involves the tagged contact (see `runtime/observation-plane/rules`).
- Observers and CRM workers MUST express state transitions by attaching/detaching tags (`ravi contacts tag/untag`) rather than overloading `contact_policies.status` or `crm_contact_profiles.lifecycle`.
- Tags used for orchestration SHOULD be defined with clear slugs and labels via `ravi tags define` and SHOULD have a documented lifecycle (which tag follows which) so the state machine is auditable.
- A tag transition MUST emit a `profile.tag_added` or equivalent `profile.tag_removed` event in `contact_events` so the timeline preserves orchestration history.
- Old observer bindings created by a previous tag MUST persist until explicit reconciliation. Operators MUST be able to detach stale observers via `ravi observers ...` without manual SQL.

This pattern keeps CRM lifecycle, access policy, and observer orchestration separate while letting contact tags coordinate the work loop.

## Acceptance Criteria

- CRM lifecycle does not change contact access policy.
- Contacts and accounts never use raw WhatsApp/Omni ids as primary keys.
- Group/chat context references `chat_id`, not contact/account ids.
- Every CRM write creates a `crm_events` row.
- Contact-related CRM writes create or link a contact timeline event.
- `ravi crm next` can answer "who needs action now?"
- `ravi contacts profile` can show CRM summary without scanning all raw messages.
- Weak agent observations enter as proposed facts or notes, not confirmed CRM state.
- Tag-driven orchestration: changing a contact's tag visibly changes which observer rules match the contact's sessions, with `ravi observers rules explain` surfacing the cause.
