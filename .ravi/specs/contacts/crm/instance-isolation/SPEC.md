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
  - workspaces
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
  boundary called a **workspace**. Two instances in different workspaces never
  see each other's commercial data; two instances in the same workspace share
  one board.

This is the hybrid model the market converged on (see
[Market Mapping](#market-mapping)). It is the only model that satisfies both
"compartilhado entre instâncias" and "isolar para não misturar" at once: pure
per-instance silos cannot share, and a single global CRM cannot isolate.

**See:** [[contacts/crm]] (canonical CRM schema),
[[contacts/crm/pipelines]] (pipeline/stage model this scopes),
[[contacts/identity-graph/unified-model]] (why identity stays global),
[[self/omni]] (instance resolution boundary),
[[crm/multi-agent-pipeline-routing]] (agent-per-pipeline routing, which becomes
workspace-scoped under this feature).

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
  — one default pipeline for the **whole daemon**, not per workspace.
- `crm_events` and `crm_facts` already carry `scope_type`/`scope_id`, but no
  current value designates an instance/workspace; `scope_type` defaults to
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

### What becomes scoped (commercial, per workspace)

- `crm_pipelines`, `crm_pipeline_stages` (stages inherit scope via pipeline).
- `crm_opportunities`, `crm_opportunity_contacts` (inherit via opportunity).
- `crm_tasks` (including commitments).
- `crm_accounts` — the commercial wrapper is scoped even though the org
  `contact` it points to stays global. Two workspaces MAY each hold their own
  `crm_accounts` row pointing at the same global org contact.
- `crm_account_contacts`, `crm_activities`, `crm_activity_participants`,
  `crm_segments`, `crm_playbooks`, `crm_playbook_runs`.
- `crm_contact_profiles` — CRM lifecycle becomes per-workspace.

### Three distinct ids — never conflate

There is an existing naming-collision hazard. These are three different concepts
and MUST keep three different column names:

- `routes.account_id` — the **omni/transport boundary** (`'unknown'`, `'ravi'`).
  It is not a CRM concept.
- `crm_accounts.id` — a **commercial account** (an org wrapper inside a
  workspace).
- `workspace_id` (new) — the **CRM tenancy boundary** introduced here.

The new column MUST be named `workspace_id` inside `crm_*` tables and
`crm_workspace_id` on the `instances` table. It MUST NOT overload `account_id` in
either of its existing meanings.

## Workspace Model

A **workspace** is the CRM tenancy boundary. One or more instances map into
exactly one workspace.

```sql
CREATE TABLE IF NOT EXISTS crm_workspaces (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  is_default INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_workspaces_default
  ON crm_workspaces(is_default)
  WHERE is_default = 1;
```

Instances reference their workspace:

```sql
ALTER TABLE instances
  ADD COLUMN crm_workspace_id TEXT
  REFERENCES crm_workspaces(id) ON DELETE SET NULL;
```

Rules:

- An instance belongs to **exactly one** workspace at a time.
- A workspace contains **one or more** instances.
- Shared CRM = several instances pointing at the same `crm_workspace_id`.
- Isolated CRM = an instance pointing at a workspace no other instance uses.
- Exactly one workspace MAY be marked `is_default = 1`; unmapped instances
  resolve to it (see [Migration Plan](#migration-plan)).

## Scope Application

### Current-state commercial tables get a concrete column

Each scoped current-state table gains a non-null `workspace_id` FK. Example for
the pipeline table (the same delta applies to opportunities, tasks, accounts,
profiles, activities, segments, playbooks):

```sql
ALTER TABLE crm_pipelines
  ADD COLUMN workspace_id TEXT NOT NULL DEFAULT '<default-workspace-id>'
  REFERENCES crm_workspaces(id) ON DELETE CASCADE;
```

The default-pipeline uniqueness constraint becomes **per workspace**:

```sql
-- replaces idx_crm_pipelines_default
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_pipelines_default
  ON crm_pipelines(workspace_id, entity_type, is_default)
  WHERE is_default = 1;
```

Every scoped read index SHOULD lead with `workspace_id` so isolated queries stay
selective, e.g.:

```sql
CREATE INDEX IF NOT EXISTS idx_crm_opportunities_ws_stage
  ON crm_opportunities(workspace_id, pipeline_id, stage_id, status, updated_at DESC);
```

### `crm_contact_profiles` becomes per-workspace

The most invasive change. Today the profile is one row per contact:

```sql
-- today
PRIMARY KEY (contact_id)
```

To let one contact be a `lead` in one workspace and `active` in another without
overwriting, the profile becomes keyed by `(contact_id, workspace_id)`:

```sql
-- proposed
workspace_id TEXT NOT NULL REFERENCES crm_workspaces(id) ON DELETE CASCADE,
PRIMARY KEY (contact_id, workspace_id)
```

This is consistent with [[contacts/identity-graph/unified-model]], which already
requires that "a contact may be allowed operationally, a lead in CRM, an admin
in one chat ... without those statuses overwriting each other." CRM lifecycle is
one such scoped status.

### Ledger and fact tables reuse the existing scope vocabulary

`crm_events` and `crm_facts` already carry `scope_type`/`scope_id`. They MUST NOT
gain a redundant `workspace_id` column. Instead they record workspace via the
existing fields:

- `scope_type = 'workspace'`
- `scope_id = <crm_workspaces.id>`

This adds `workspace` to the scope-type vocabulary alongside
`global|domain|project|chat|session|org|agent|task`. Workspace-scoped writes MUST
set both fields; the existing `CHECK(scope_type = 'global' OR scope_id IS NOT NULL)`
already enforces that a non-global scope carries an id.

## Resolution Path

A CRM operation must resolve its workspace from the request context before any
scoped read or write. This extends the [[self/omni]] projection rule:

```text
Omni raw event
  -> instances.instance_id            (transport boundary, existing)
  -> instances.crm_workspace_id        (this feature)
  -> CRM workspace scope
  -> scoped pipelines / opportunities / tasks / profile
```

Rules:

- If the instance has no `crm_workspace_id`, resolution falls back to the
  `is_default` workspace and MUST label the result as default-scoped provenance,
  never silently as a bespoke workspace.
- Agent/CLI operations that are not tied to an instance (admin tooling) MUST pass
  an explicit `--workspace <slug>`; they MUST NOT default to "all workspaces"
  implicitly (see [Application-Layer Enforcement](#application-layer-enforcement)).

## Application-Layer Enforcement

SQLite has **no row-level security**. Unlike a Postgres pooled-tenant design,
isolation here cannot be enforced by the database. It is enforced in the
application layer, which is leakier and demands discipline:

- All scoped CRM reads/writes MUST pass through a single resolver/guard that
  injects `workspace_id = ?` (or `scope_id = ?`). Ad-hoc queries that forget the
  filter are the primary leak vector.
- The guard MUST **fail closed**: a scoped query with no resolved workspace
  returns nothing (or errors), never every workspace's rows.
- Cross-workspace reads MUST be an explicit, audited admin capability
  (`--all-workspaces` or equivalent), never the default.
- A test/lint check SHOULD assert that no `crm_*` current-state query in
  `src/contacts.ts` / `src/cli/commands/crm.ts` runs without a workspace
  predicate (see [Validation](#validation)).

## Market Mapping

| Pattern | Enforcement | Market example | Fit for Ravi |
| --- | --- | --- | --- |
| Pooled (shared DB + tenant_id + RLS) | DB row-level security | Postgres SaaS multi-tenant | Closest in shape, but RLS unavailable on SQLite |
| Hybrid / business-unit (shared identity + scoped commercial) | App layer + shared identity graph | HubSpot Business Units | **Chosen model** |
| Silo (schema/DB per tenant) | Physical separation | Salesforce orgs/divisions | Over-isolated; breaks shared identity, heavy ops |

Ravi adopts the **hybrid** model: shared identity graph + workspace-scoped
commercial layer, enforced at the application layer because the store is SQLite.
This mirrors HubSpot Business Units (shared contacts, business-unit-scoped deals)
rather than Salesforce-style separate orgs.

## Migration Plan

This feature changes `src/db.ts` and is therefore HITL-gated (AGENTS.md C.15).
The phases below are designed so each step is behavior-preserving until an
operator explicitly opts an instance into its own workspace. **No schema change
ships without RM approval of the concrete diff.**

1. **Phase 0 — today.** Everything global. No workspace concept.
2. **Phase 1 — introduce default workspace (no behavior change).**
   - Create `crm_workspaces`; seed one row `slug='default'`, `is_default=1`.
   - Add `workspace_id` to scoped tables with `DEFAULT '<default-id>'`; backfill
     all existing rows to the default workspace.
   - Add `instances.crm_workspace_id`; map every existing instance to default.
   - Migrate `crm_contact_profiles` to the `(contact_id, workspace_id)` key with
     all rows under default.
   - Result: one shared workspace = identical behavior to today.
3. **Phase 2 — enforce scope in resolvers.**
   - Route all scoped CRM access through the workspace guard (fail-closed).
   - Update CLI/SDK to resolve workspace from instance context.
   - Still one workspace, so still no visible change.
4. **Phase 3 — operators split workspaces.**
   - `ravi crm workspace create <slug>` and remap an instance
     (`ravi crm workspace assign <instance> <workspace>`).
   - First real isolation boundary appears (e.g. Galvanotek → own workspace).

## CLI Contract

```bash
ravi crm workspace list [--json]
ravi crm workspace show <workspace> [--json]
ravi crm workspace create <slug> --name <name> [--json]
ravi crm workspace assign <instance> <workspace> [--json]
ravi crm workspace set-default <workspace> [--json]
```

Scoped CRM commands gain an optional `--workspace <slug>` override; when omitted
inside an instance-bound context they resolve via the instance, and in
admin/agent contexts they MUST require it explicitly.

Rules:

- `--json` responses MUST expose a typed `workspace` object and echo the resolved
  `workspace_id` on every scoped result so callers can confirm isolation.
- Remapping an instance between workspaces MUST be an audited write and MUST NOT
  move identity rows.

## Audit Events

Workspace lifecycle and mapping writes MUST create `crm_events` rows:

- `crm.workspace.created`
- `crm.workspace.updated`
- `crm.workspace.default_changed`
- `crm.instance.workspace_assigned` (payload includes previous + next workspace)

All scoped commercial writes MUST set `scope_type='workspace'` / `scope_id` on
their `crm_events` row so the ledger reconstructs which workspace each change
belongs to.

## Invariants

- A `contact` and its `platform_identities` MUST NOT be duplicated or forked per
  workspace. Identity is global.
- Every scoped `crm_*` current-state row MUST carry a non-null `workspace_id`.
- A scoped CRM read with no resolved workspace MUST fail closed (return nothing /
  error), never return all workspaces.
- Exactly one `crm_workspaces` row MAY have `is_default = 1`.
- One default pipeline per `(workspace_id, entity_type)` — never one global
  default across workspaces.
- Reassigning an instance's workspace MUST move only the commercial association
  and MUST be audited; it MUST NOT touch `contacts` or `platform_identities`.
- Workspace-scoped `crm_events`/`crm_facts` MUST set both `scope_type='workspace'`
  and `scope_id`.

## Validation

- `ravi crm workspace list --json` returns the seeded default plus any created
  workspaces.
- Create two instances, map to **different** workspaces, create an opportunity in
  each: `ravi crm board --workspace A` MUST NOT show workspace B's opportunity.
- Map two instances to the **same** workspace: both see one shared board.
- One phone messaging two instances in two workspaces yields **one** `contacts`
  row and **two** `crm_contact_profiles` rows (one per workspace).
- A static check (lint or test) asserts no scoped `crm_*` query in
  `src/contacts.ts` / `src/cli/commands/crm.ts` omits the workspace predicate.
- Migration dry-run on a copy of `~/.ravi/chat.db` backfills every existing CRM
  row to the default workspace with zero orphans.

## Known Failure Modes

- **Silent cross-workspace leak.** A query forgets the workspace predicate and
  returns another workspace's deals. Prevented by the fail-closed guard + static
  check.
- **Identity fork.** Treating `platform_identities.instance_id` as the CRM
  partition would split one person into per-instance contacts. Prohibited:
  `instance_id` is provenance only.
- **`account_id` overload.** Reusing `routes.account_id` or `crm_accounts.id` as
  the tenancy key. Prevented by the dedicated `workspace_id` / `crm_workspace_id`
  names.
- **Lifecycle clobber.** Keeping `crm_contact_profiles` keyed by `contact_id`
  alone forces one global lifecycle and overwrites per-workspace state.
- **Default-workspace drift.** More than one `is_default=1`, or an unmapped
  instance silently resolving to a non-default workspace.

## Open Decisions (HITL)

These require RM sign-off before implementation:

1. **Boundary name.** `workspace` (proposed) vs `tenant` vs `business-unit`. This
   is public CLI/SDK surface (AGENTS.md C.16) and hard to rename later.
2. **`crm_contact_profiles` re-key.** Confirm the `(contact_id, workspace_id)`
   primary-key migration vs a separate per-workspace overlay table.
3. **Account scope.** Confirm `crm_accounts` is workspace-scoped (proposed) vs a
   shared org directory with per-workspace opportunity scope only.
4. **NATS emission.** Whether workspace assignment/commercial moves emit an omni
   event (current `moveCrmOpportunityStage` writes `crm_events` but emits no
   NATS — pre-existing gap, see [[crm/multi-agent-pipeline-routing]]).

## Acceptance Criteria

- The `representante galvanotek` instance can be given an isolated workspace
  without exposing or touching the `sde` instance's pipelines, opportunities, or
  tasks.
- Two instances configured to share a workspace operate on one CRM board.
- One person contacting two instances in two workspaces is a single contact with
  two independent commercial lifecycles and zero identity duplication.
- A scoped CRM query that omits workspace scope is rejected by guard/test, not
  shipped.
- Phase 1 migration leaves observable behavior identical to today (single shared
  default workspace).
- Every workspace lifecycle and commercial write is reconstructable from
  `crm_events` via `scope_type='workspace'`.
