---
id: contacts/crm/instance-isolation
title: CRM Instance Isolation
kind: feature
domain: contacts
capability: crm
feature: instance-isolation
tags:
  - contacts
  - crm
  - multi-tenancy
  - instances
  - isolation
  - business-units
applies_to:
  - src/db.ts
  - src/contacts.ts
  - src/cli/commands/crm.ts
  - src/router
  - packages/ravi-os-sdk/src/client.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# CRM Instance Isolation

## Intent

One Ravi daemon serves multiple instances (one WhatsApp number / business front
per instance). This feature defines how a **single CRM codebase** serves all of
them while letting operators choose, per group of instances, whether commercial
data is **shared** or **isolated**.

The design splits the CRM into two layers with opposite tenancy rules:

- **Identity layer is shared.** A person or organization is one canonical
  `contact`. One phone number is one person across every instance. Identity is
  never duplicated per instance.
- **Commercial layer is scoped.** Pipelines, opportunities, CRM tasks, accounts
  as commercial wrappers, and per-contact CRM lifecycle belong to a tenancy
  boundary called a **business unit**. Two instances in different business units
  never see each other's commercial data; two instances in the same business
  unit share one board.

This is the hybrid model the market converged on (see
[Market Mapping](#market-mapping)). It is the only model that satisfies both
"compartilhado entre instâncias" and "isolar para não misturar" at once: pure
per-instance silos cannot share, and a single global CRM cannot isolate.

**See:** [[contacts/crm]] (canonical CRM schema),
[[contacts/crm/pipelines]] (pipeline/stage model this scopes),
[[contacts/identity-graph/unified-model]] (why identity stays global),
[[self/omni]] (instance resolution boundary),
[[crm/multi-agent-pipeline-routing]] (agent-per-pipeline routing, which becomes
business-unit-scoped under this feature).

## Current Reality (single-tenant)

This spec documents a change to existing behavior. Today the CRM is **fully
global / single-tenant**:

- `crm_pipelines`, `crm_pipeline_stages`, `crm_opportunities`, `crm_tasks`,
  `crm_accounts`, `crm_account_contacts`, `crm_activities`, `crm_segments`, and
  `crm_playbooks` have **no scope column**. Every row is visible to every
  instance.
- `crm_contact_profiles` has `PRIMARY KEY (contact_id)` — exactly one global
  lifecycle per contact, with no room for "lead in instance A, active in
  instance B".
- `crm_pipelines` enforces `UNIQUE(entity_type, is_default) WHERE is_default = 1`
  — one default pipeline for the **whole daemon**, not per business unit.
- `crm_events` and `crm_facts` already carry `scope_type`/`scope_id`, but no
  current value designates an instance/business unit; `scope_type` defaults to
  `global`.

Sharing is therefore free and already total; **isolation is what must be built**.

## Boundaries

### What stays shared (identity, global)

- `contacts` — canonical person/org. Never forked per instance.
- `platform_identities` — channel identities. The existing
  `platform_identities.instance_id` records **which instance observed** an
  identity. It is transport provenance, not a CRM partition key, and MUST NOT be
  repurposed as the commercial isolation boundary.
- `contact_policies` — access control (`allowed`/`pending`/`blocked`/`discovered`)
  remains contact-scoped and is out of scope for commercial isolation.

### What becomes scoped (commercial, per business unit)

- `crm_pipelines`, `crm_pipeline_stages` (stages inherit scope via pipeline).
- `crm_opportunities`, `crm_opportunity_contacts` (inherit via opportunity).
- `crm_tasks` (including commitments).
- `crm_accounts` — the commercial wrapper is scoped even though the org
  `contact` it points to stays global. Two business units MAY each hold their own
  `crm_accounts` row pointing at the same global org contact.
- `crm_account_contacts`, `crm_activities`, `crm_activity_participants`,
  `crm_segments`, `crm_playbooks`, `crm_playbook_runs`.
- `crm_contact_profiles` — CRM lifecycle becomes per-business-unit.

### Three distinct ids — never conflate

There is an existing naming-collision hazard. These are three different concepts
and MUST keep three different column names:

- `routes.account_id` — the **omni/transport boundary** (`'unknown'`, `'ravi'`).
  It is not a CRM concept.
- `crm_accounts.id` — a **commercial account** (an org wrapper inside a
  business unit).
- `business_unit_id` (new) — the **CRM tenancy boundary** introduced here.

The new column MUST be named `business_unit_id` inside `crm_*` tables and
`crm_business_unit_id` on the `instances` table. It MUST NOT overload
`account_id` in either of its existing meanings.

## Business Unit Model

A **business unit** is the CRM tenancy boundary. One or more instances map into
exactly one business unit.

```sql
CREATE TABLE IF NOT EXISTS crm_business_units (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  is_default INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_business_units_default
  ON crm_business_units(is_default)
  WHERE is_default = 1;
```

Instances reference their business unit:

```sql
ALTER TABLE instances
  ADD COLUMN crm_business_unit_id TEXT
  REFERENCES crm_business_units(id) ON DELETE SET NULL;
```

Rules:

- An instance belongs to **exactly one** business unit at a time.
- A business unit contains **one or more** instances.
- Shared CRM = several instances pointing at the same `crm_business_unit_id`.
- Isolated CRM = an instance pointing at a business unit no other instance uses.
- Exactly one business unit MAY be marked `is_default = 1`; unmapped instances
  resolve to it (see [Migration Plan](#migration-plan)).

## Scope Application

### Current-state commercial tables get a concrete column

Each scoped current-state table gains a non-null `business_unit_id` FK. Example
for the pipeline table (the same delta applies to opportunities, tasks, accounts,
profiles, activities, segments, playbooks):

```sql
ALTER TABLE crm_pipelines
  ADD COLUMN business_unit_id TEXT NOT NULL DEFAULT '<default-business-unit-id>'
  REFERENCES crm_business_units(id) ON DELETE CASCADE;
```

The default-pipeline uniqueness constraint becomes **per business unit**:

```sql
-- replaces idx_crm_pipelines_default
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_pipelines_default
  ON crm_pipelines(business_unit_id, entity_type, is_default)
  WHERE is_default = 1;
```

Every scoped read index SHOULD lead with `business_unit_id` so isolated queries
stay selective, e.g.:

```sql
CREATE INDEX IF NOT EXISTS idx_crm_opportunities_bu_stage
  ON crm_opportunities(business_unit_id, pipeline_id, stage_id, status, updated_at DESC);
```

### Per-business-unit contact lifecycle (additive overlay)

A contact may be a `lead` in one business unit and `active` in another. That
requires per-business-unit lifecycle without overwriting. There are two ways to
model it, and the choice is dictated by what the boot-time migrator can safely do
(see [Migration Mechanism](#migration-mechanism)).

**Recommended (non-breaking): a new overlay table.** `crm_contact_profiles`
stays exactly as it is today (`PRIMARY KEY (contact_id)`), and per-business-unit
lifecycle lives in a brand-new table whose composite primary key is declared in
its own `CREATE TABLE` — which the additive reconciler handles, because creating
a new table is safe even though `ALTER`-ing a primary key is not:

```sql
CREATE TABLE IF NOT EXISTS crm_contact_business_unit_profiles (
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  business_unit_id TEXT NOT NULL REFERENCES crm_business_units(id) ON DELETE CASCADE,

  lifecycle TEXT NOT NULL DEFAULT 'unknown',
  relationship_health TEXT NOT NULL DEFAULT 'unknown',
  priority TEXT NOT NULL DEFAULT 'normal',
  score REAL,
  health_score REAL,
  owner_type TEXT,
  owner_id TEXT,
  primary_account_id TEXT REFERENCES crm_accounts(id) ON DELETE SET NULL,
  primary_opportunity_id TEXT REFERENCES crm_opportunities(id) ON DELETE SET NULL,
  last_meaningful_interaction_at TEXT,
  next_action_at TEXT,
  next_action_summary TEXT,
  next_task_id TEXT REFERENCES crm_tasks(id) ON DELETE SET NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  PRIMARY KEY (contact_id, business_unit_id)
);
```

Existing `crm_contact_profiles` rows project into the default business unit's
overlay row during Phase 1. The legacy table MAY remain as the default-business-
unit read-model or be deprecated in place later; either way no existing upsert
path changes in Phase 1.

**Rejected (breaking): re-key `crm_contact_profiles` to
`(contact_id, business_unit_id)`.** SQLite cannot `ALTER` a primary key, so this
needs a full table rebuild (the reconciler refuses it), and it breaks every
`ON CONFLICT(contact_id)` upsert (`src/contacts.ts`), the single-row getter
`getCrmContactProfileRow(contactId)`, and the merge delete. This path is not
chosen precisely because it cannot ship without breakage.

This overlay is consistent with [[contacts/identity-graph/unified-model]], which
already requires that "a contact may be allowed operationally, a lead in CRM, an
admin in one chat ... without those statuses overwriting each other." CRM
lifecycle is one such scoped status.

### Ledger and fact tables reuse the existing scope vocabulary

`crm_events` and `crm_facts` already carry `scope_type`/`scope_id`. They MUST NOT
gain a redundant `business_unit_id` column. Instead they record the business unit
via the existing fields:

- `scope_type = 'business_unit'`
- `scope_id = <crm_business_units.id>`

This adds `business_unit` to the scope-type vocabulary alongside
`global|domain|project|chat|session|org|agent|task`. Business-unit-scoped writes
MUST set both fields; the existing
`CHECK(scope_type = 'global' OR scope_id IS NOT NULL)` already enforces that a
non-global scope carries an id.

## Resolution Path

A CRM operation must resolve its business unit from the request context before
any scoped read or write. This extends the [[self/omni]] projection rule:

```text
Omni raw event
  -> instances.instance_id              (transport boundary, existing)
  -> instances.crm_business_unit_id      (this feature)
  -> CRM business-unit scope
  -> scoped pipelines / opportunities / tasks / profile
```

Rules:

- If the instance has no `crm_business_unit_id`, resolution falls back to the
  `is_default` business unit and MUST label the result as default-scoped
  provenance, never silently as a bespoke business unit.
- Agent/CLI operations that are not tied to an instance (admin tooling) MUST pass
  an explicit `--business-unit <slug>`; they MUST NOT default to "all business
  units" implicitly (see
  [Application-Layer Enforcement](#application-layer-enforcement)).

## Application-Layer Enforcement

SQLite has **no row-level security**. Unlike a Postgres pooled-tenant design,
isolation here cannot be enforced by the database. It is enforced in the
application layer, which is leakier and demands discipline:

- All scoped CRM reads/writes MUST pass through a single resolver/guard that
  injects `business_unit_id = ?` (or `scope_id = ?`). Ad-hoc queries that forget
  the filter are the primary leak vector.
- The guard MUST **fail closed**: a scoped query with no resolved business unit
  returns nothing (or errors), never every business unit's rows.
- Cross-business-unit reads MUST be an explicit, audited admin capability
  (`--all-business-units` or equivalent), never the default.
- A test/lint check SHOULD assert that no `crm_*` current-state query in
  `src/contacts.ts` / `src/cli/commands/crm.ts` runs without a business-unit
  predicate (see [Validation](#validation)).

## Market Mapping

| Pattern | Enforcement | Market example | Fit for Ravi |
| --- | --- | --- | --- |
| Pooled (shared DB + tenant_id + RLS) | DB row-level security | Postgres SaaS multi-tenant | Closest in shape, but RLS unavailable on SQLite |
| Hybrid / business-unit (shared identity + scoped commercial) | App layer + shared identity graph | HubSpot Business Units | **Chosen model** |
| Silo (schema/DB per tenant) | Physical separation | Salesforce orgs/divisions | Over-isolated; breaks shared identity, heavy ops |

Ravi adopts the **hybrid** model: shared identity graph + business-unit-scoped
commercial layer, enforced at the application layer because the store is SQLite.
This mirrors HubSpot Business Units (shared contacts, business-unit-scoped deals)
rather than Salesforce-style separate orgs. The implementation surface carries
the same vocabulary as the model it copies (see Open Decision #1).

## Migration Mechanism

Schema evolves on boot via `reconcileColumns()` (`src/db/reconcile-columns.ts`):
it diffs the live SQLite database against the declarative schema and runs
`ALTER TABLE ADD COLUMN` for any declared column missing in the live table. Its
documented limits decide what is safe:

- It **can** add a column, including `NOT NULL` **with a constant `DEFAULT`** —
  which backfills existing rows in place.
- It **cannot** add a `PRIMARY KEY` or `UNIQUE` constraint, recreate an index,
  drop a column, or run a data rebuild.

Splitting the deltas against that boundary:

- **Additive (auto on boot, non-breaking):** the `crm_business_units` table,
  `business_unit_id TEXT NOT NULL DEFAULT '<default-id>'` on each scoped
  commercial table, `instances.crm_business_unit_id`, and the
  `crm_contact_business_unit_profiles` overlay table. All ship through the
  reconciler with zero code-path changes.
- **Non-additive (explicit, deferred):** the per-business-unit default-pipeline
  index swap (`UNIQUE(business_unit_id, entity_type, is_default)`) needs a
  drop/recreate index step the reconciler will not perform. It only matters once
  a second business unit exists, so it is deferred to Phase 3 and gated behind an
  explicit migration step, not boot reconciliation.
- **Avoided (would force a rebuild):** re-keying `crm_contact_profiles`. The
  overlay table exists specifically to keep this delta out of the migration.

## Migration Plan

This feature changes the CRM schema and is therefore HITL-gated (AGENTS.md C.15).
The phases below are designed so each step is behavior-preserving until an
operator explicitly opts an instance into its own business unit. **No schema
change ships without RM approval of the concrete diff.**

1. **Phase 0 — today.** Everything global. No business-unit concept.
2. **Phase 1 — introduce default business unit (no behavior change, additive
   only).**
   - Create `crm_business_units`; seed one row `slug='default'`, `is_default=1`.
   - Add `business_unit_id` to scoped tables with `DEFAULT '<default-id>'`; the
     reconciler backfills all existing rows to the default business unit.
   - Add `instances.crm_business_unit_id`; map every existing instance to
     default.
   - Create the `crm_contact_business_unit_profiles` overlay; project existing
     `crm_contact_profiles` rows into the default business unit. The legacy table
     and its `ON CONFLICT(contact_id)` upserts stay untouched.
   - Result: one shared business unit = identical behavior to today, applied
     entirely through `reconcileColumns()` on boot.
3. **Phase 2 — enforce scope in resolvers.**
   - Route all scoped CRM access through the business-unit guard (fail-closed).
   - Update CLI/SDK to resolve business unit from instance context.
   - Still one business unit, so still no visible change.
4. **Phase 3 — operators split business units.**
   - Apply the non-additive default-pipeline index swap via an explicit migration
     step (drop/recreate), since a second default pipeline now needs to coexist.
   - `ravi crm business-unit create <slug>` and remap an instance
     (`ravi crm business-unit assign <instance> <business-unit>`).
   - First real isolation boundary appears (e.g. Galvanotek → own business unit).

## CLI Contract

```bash
ravi crm business-unit list [--json]
ravi crm business-unit show <business-unit> [--json]
ravi crm business-unit create <slug> --name <name> [--json]
ravi crm business-unit assign <instance> <business-unit> [--json]
ravi crm business-unit set-default <business-unit> [--json]
```

The `bu` alias is accepted for the noun (`ravi crm bu list`, `--bu <slug>`) to
keep the common path terse without giving up the legible primary name.

Scoped CRM commands gain an optional `--business-unit <slug>` (alias `--bu`)
override; when omitted inside an instance-bound context they resolve via the
instance, and in admin/agent contexts they MUST require it explicitly.

Rules:

- `--json` responses MUST expose a typed `business_unit` object and echo the
  resolved `business_unit_id` on every scoped result so callers can confirm
  isolation.
- Remapping an instance between business units MUST be an audited write and MUST
  NOT move identity rows.

## Audit Events

Business-unit lifecycle and mapping writes MUST create `crm_events` rows:

- `crm.business_unit.created`
- `crm.business_unit.updated`
- `crm.business_unit.default_changed`
- `crm.instance.business_unit_assigned` (payload includes previous + next
  business unit)

All scoped commercial writes MUST set `scope_type='business_unit'` / `scope_id`
on their `crm_events` row so the ledger reconstructs which business unit each
change belongs to.

## Invariants

- A `contact` and its `platform_identities` MUST NOT be duplicated or forked per
  business unit. Identity is global.
- Every scoped `crm_*` current-state row MUST carry a non-null `business_unit_id`.
- A scoped CRM read with no resolved business unit MUST fail closed (return
  nothing / error), never return all business units.
- Exactly one `crm_business_units` row MAY have `is_default = 1`.
- One default pipeline per `(business_unit_id, entity_type)` — never one global
  default across business units.
- Reassigning an instance's business unit MUST move only the commercial
  association and MUST be audited; it MUST NOT touch `contacts` or
  `platform_identities`.
- Business-unit-scoped `crm_events`/`crm_facts` MUST set both
  `scope_type='business_unit'` and `scope_id`.

## Validation

- `ravi crm business-unit list --json` returns the seeded default plus any
  created business units.
- Create two instances, map to **different** business units, create an
  opportunity in each: `ravi crm board --business-unit A` MUST NOT show business
  unit B's opportunity.
- Map two instances to the **same** business unit: both see one shared board.
- One phone messaging two instances in two business units yields **one**
  `contacts` row and **two** `crm_contact_business_unit_profiles` rows (one per
  business unit).
- A static check (lint or test) asserts no scoped `crm_*` query in
  `src/contacts.ts` / `src/cli/commands/crm.ts` omits the business-unit
  predicate.
- Migration dry-run on a copy of `~/.ravi/chat.db` backfills every existing CRM
  row to the default business unit with zero orphans.

## Known Failure Modes

- **Silent cross-business-unit leak.** A query forgets the business-unit
  predicate and returns another business unit's deals. Prevented by the
  fail-closed guard + static check.
- **Identity fork.** Treating `platform_identities.instance_id` as the CRM
  partition would split one person into per-instance contacts. Prohibited:
  `instance_id` is provenance only.
- **`account_id` overload.** Reusing `routes.account_id` or `crm_accounts.id` as
  the tenancy key. Prevented by the dedicated `business_unit_id` /
  `crm_business_unit_id` names.
- **Lifecycle clobber.** Writing per-business-unit lifecycle into the single
  global `crm_contact_profiles` row overwrites another business unit's state.
  Prevented by the `crm_contact_business_unit_profiles` overlay keyed by
  `(contact_id, business_unit_id)`.
- **Default-business-unit drift.** More than one `is_default=1`, or an unmapped
  instance silently resolving to a non-default business unit.

## Open Decisions (HITL)

Decisions #1–#3 are resolved — RM delegated the market call to ravi-dev
(2026-05-29: "vc qm decide de acordo com o mercado"). #4 remains open. The
resolutions below are baked into the spec above; they are recorded here for RM
ratification and remain reversible until code ships.

1. **Boundary name — resolved (`business-unit`).** Chosen over `workspace` and
   `tenant`. Rationale: (a) the feature *is* the HubSpot Business Units model
   (see [Market Mapping](#market-mapping)), so the implementation surface should
   carry the same vocabulary as the model it copies — one coherent term end to
   end instead of "we cloned Business Units but call it workspace"; (b)
   `workspace` is already overloaded in this codebase (task workspace / agent
   cwd, workspace profile roots, `getWorkspaceMessageSlotKey`), and this name
   becomes a permanent column (`business_unit_id`) and public CLI surface
   (AGENTS.md C.16) — reusing `workspace` would bake in exactly the kind of
   identifier overload this spec already prohibits for `account_id`; (c) `tenant`
   is the precise infra term but reads as engineering jargon to the sales
   operator who runs `ravi crm`, whereas "business unit" is legible to them. CLI
   verbosity is mitigated by the `bu` alias. Surface: table `crm_business_units`,
   columns `business_unit_id` / `crm_business_unit_id`, scope value
   `business_unit`, CLI `ravi crm business-unit` (alias `bu`).
2. **Per-business-unit lifecycle storage — resolved (overlay).** Use the additive
   `crm_contact_business_unit_profiles` overlay table, not a `crm_contact_profiles`
   re-key. Verified against `src/db/reconcile-columns.ts`: the re-key forces a
   table rebuild the boot reconciler refuses and breaks the existing
   `ON CONFLICT(contact_id)` upserts in `src/contacts.ts`.
3. **Account scope — resolved (business-unit-scoped).** `crm_accounts` carries
   `business_unit_id` like every other commercial table. Rationale: `crm_accounts`
   is the *commercial wrapper*, not an identity object — the organization's
   identity lives in its shared `contacts` row (kind=org). Scoping the wrapper
   therefore does not duplicate identity: the same global org contact may be
   referenced by one `crm_accounts` row per business unit, each holding that
   unit's own commercial state (owner, lifecycle, deal rollup). A shared account
   directory + per-business-unit overlay would only be warranted if `crm_accounts`
   held identity attributes, which it does not. Scoped accounts also keep Phase 1
   uniform (accounts get a column like opportunities/pipelines/tasks; no extra
   overlay).
4. **NATS emission — open (recommend defer).** Whether business-unit assignment /
   commercial moves emit an omni event (current `moveCrmOpportunityStage` writes
   `crm_events` but emits no NATS — pre-existing gap). Recommend deferring to the
   agent-per-pipeline routing work, see [[crm/multi-agent-pipeline-routing]].

## Acceptance Criteria

- The `representante galvanotek` instance can be given an isolated business unit
  without exposing or touching the `sde` instance's pipelines, opportunities, or
  tasks.
- Two instances configured to share a business unit operate on one CRM board.
- One person contacting two instances in two business units is a single contact
  with two independent commercial lifecycles and zero identity duplication.
- A scoped CRM query that omits business-unit scope is rejected by guard/test,
  not shipped.
- Phase 1 migration leaves observable behavior identical to today (single shared
  default business unit).
- Every business-unit lifecycle and commercial write is reconstructable from
  `crm_events` via `scope_type='business_unit'`.
