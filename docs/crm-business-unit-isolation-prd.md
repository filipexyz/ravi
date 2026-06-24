# CRM Business-Unit Isolation — Phase 1 PRD

## Summary

One Ravi daemon serves many instances — one WhatsApp number / business front per
instance. Today the CRM is fully global: every instance sees every pipeline,
opportunity, account, task and activity. Operators need the opposite for
commercial data: two business fronts must not see each other's deals, while the
same human contacting both is still **one** person.

This PRD proposes — and this PR ships **Phase 1 of** — a hybrid multi-tenancy
model: **identity stays shared, commercial data becomes scoped to a business
unit.** Phase 1 is deliberately additive and behavior-preserving: it lays the
schema for isolation while leaving observable behavior identical to today (one
implicit default business unit that every existing row already belongs to). The
enforcement (Phase 2) and the operator-facing split (Phase 3) are designed but
intentionally **not** in this PR.

The normative contract lives in the canonical spec:
`.ravi/specs/contacts/crm/instance-isolation/SPEC.md`. This document is the
human-readable briefing behind it.

## Problem

The CRM was built single-tenant. Concretely, in the current schema
(`src/contacts.ts`):

- `crm_pipelines`, `crm_opportunities`, `crm_tasks`, `crm_accounts`,
  `crm_activities` (and their child tables) have **no scope column**. Every row
  is visible to every instance.
- `crm_contact_profiles` has `PRIMARY KEY (contact_id)` — exactly one global CRM
  lifecycle per contact. There is no room for "lead for business front A, active
  customer for business front B".
- `crm_pipelines` enforces one default pipeline for the **whole daemon**
  (`UNIQUE(entity_type, is_default) WHERE is_default = 1`), not one per tenant.

So **sharing is already total and free; isolation is what must be built.** The
requirement is genuinely hybrid, and that is what makes it non-trivial:

- *Identity must stay shared.* One phone number is one person across every
  instance. Duplicating a contact per instance would fork the identity graph and
  break dedupe, history, and consent.
- *Commercial data must isolate.* Pipelines/opportunities/accounts/tasks for
  business front A must be invisible to business front B.

Neither naive design satisfies both: a single global CRM cannot isolate, and
per-instance silos cannot share identity. A real tenancy boundary is required —
one that sits **below** identity and **above** the commercial tables.

A second, store-level constraint shapes everything: Ravi's CRM is **SQLite**, and
the CRM identity/commercial schema (`chat.db`) is a *different database file*
from the router's `instances` table (`ravi.db`). SQLite has no row-level
security and cannot enforce foreign keys across files. Both facts directly
constrain the design (see Methodology and The Change).

## Investigation Methodology

This was investigated bottom-up against the real code and the real engine, not
designed on paper:

1. **Schema census.** Read the live CRM schema in `src/contacts.ts` and the
   router schema in `src/router/router-db.ts`. Classified every table as
   *identity* (shared) vs *commercial* (must scope), and catalogued the existing
   id columns to avoid collisions — `routes.account_id` (transport boundary),
   `crm_accounts.id` (commercial account), and the new tenancy key are three
   different concepts that must keep three different names. The tenancy key is
   therefore `business_unit_id` (on `crm_*`) / `crm_business_unit_id` (on
   `instances`) and never overloads `account_id`.

2. **Migration-mechanism audit.** Established *how* the CRM schema actually
   evolves. It is not a migration-file system: `initializeCrmSchema()` runs on
   every boot via `CREATE TABLE IF NOT EXISTS` plus a guarded
   `ensureTableColumn()` helper (a `PRAGMA table_info` check followed by
   `ALTER TABLE ADD COLUMN`). Whatever Phase 1 does has to be expressible inside
   that additive boundary, or it cannot ship without a hand-written rebuild.

3. **Empirical probing of SQLite's `ALTER TABLE` limits.** Rather than assume,
   the boundary was confirmed against the engine. Two hard limits decided the
   design:
   - Under `PRAGMA foreign_keys = ON` (which `src/contacts.ts` sets), SQLite
     **rejects** `ADD COLUMN ... NOT NULL DEFAULT '<x>' REFERENCES ...` —
     "Cannot add a REFERENCES column with non-NULL default value." A `NOT NULL`
     added column needs a non-null default; an added `REFERENCES` column requires
     a `NULL` default. They cannot coexist in one `ALTER`. → The FK is deferred.
   - SQLite resolves a foreign key's parent table at **prepare time**. Naming a
     parent that lives in another database file (or is absent) makes *every*
     prepared `INSERT`/`UPDATE` on the child fail with "no such table" — a boot
     crash, not a lazy runtime error. → The cross-file `instances` pointer
     carries **no** FK at all.

4. **Cross-file boundary check.** Confirmed `instances` (router, `ravi.db`) and
   `crm_business_units` (contacts, `chat.db`) are separate files, so a SQLite FK
   between them is impossible by construction — independent of phase. Referential
   integrity for that pointer is therefore an application-layer responsibility
   (the Phase 2 resolver), and the column stays a plain nullable `TEXT`.

5. **Market research on the tenancy pattern** (see Design Research) to choose the
   model deliberately rather than inventing one.

6. **Spike + isolated tests before wiring.** Proved the additive migration on a
   throwaway DB (new table + seed + `ADD COLUMN NOT NULL DEFAULT` backfill +
   overlay) and locked the behavior with focused tests **before** integrating —
   including a faithful "legacy" pre-migration table to prove the backfill of
   rows that predate the new column.

## Design Research

The tenancy boundary was chosen by mapping the established market patterns onto
Ravi's constraints rather than by preference:

| Pattern | Enforcement | Market example | Fit for Ravi |
| --- | --- | --- | --- |
| Pooled (shared DB + `tenant_id` + RLS) | DB row-level security | Postgres SaaS multi-tenant | Closest in shape — but **RLS does not exist on SQLite** |
| Hybrid / business-unit (shared identity + scoped commercial) | App layer + shared identity graph | **HubSpot Business Units** | **Chosen** |
| Silo (schema or DB per tenant) | Physical separation | Salesforce orgs / divisions | Over-isolated; **breaks shared identity**, heavy ops |

The chosen model mirrors **HubSpot Business Units**: a single shared contact
record with **business-unit-scoped** deals/pipelines layered on top. It is the
only one of the three that satisfies *both* "share identity across fronts" and
"isolate commercial data" at once — Salesforce-style separate orgs would fork the
person, and a single global CRM cannot isolate at all.

Two deliberate consequences of that choice:

- **Vocabulary matches the model.** Because the feature *is* the Business Units
  pattern, the implementation surface carries the same name end to end —
  `crm_business_units`, `business_unit_id`, CLI `ravi crm business-unit` (terse
  `bu` alias) — instead of cloning Business Units but calling it "workspace"
  (already overloaded in this codebase) or "tenant" (infra jargon to the sales
  operator who runs the CLI).
- **Enforcement is honest about the store.** SQLite has no RLS, so isolation
  cannot be a database guarantee. Phase 2 routes all scoped CRM access through a
  single **fail-closed** resolver that injects `business_unit_id = ?`; a scoped
  query with no resolved business unit returns nothing, never every tenant's
  rows. This PR documents that contract; it does not yet enforce it (no behavior
  to enforce while there is one business unit).

## The Change (Phase 1 — what ships in this PR)

Phase 1 is **additive and behavior-identical**. Every delta is `ADD COLUMN`-safe
or `CREATE ... IF NOT EXISTS`, so it applies to an existing `~/.ravi` database
with no rebuild and no behavior change.

**1. Business-unit table + single-default guard + seed** (`src/contacts.ts`,
inside `initializeCrmSchema()`):

```sql
CREATE TABLE IF NOT EXISTS crm_business_units (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0, 1)),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_business_units_default
  ON crm_business_units(is_default) WHERE is_default = 1;
INSERT OR IGNORE INTO crm_business_units (id, slug, name, is_default)
  VALUES ('default', 'default', 'Default', 1);
```

The partial unique index enforces the invariant "at most one default business
unit." The seed is idempotent.

**2. Scope column on the five commercial tables** (additive, no inline FK):

```sql
ensureTableColumn(db, "crm_pipelines",     "business_unit_id", "TEXT NOT NULL DEFAULT 'default'");
ensureTableColumn(db, "crm_opportunities", "business_unit_id", "TEXT NOT NULL DEFAULT 'default'");
ensureTableColumn(db, "crm_tasks",         "business_unit_id", "TEXT NOT NULL DEFAULT 'default'");
ensureTableColumn(db, "crm_accounts",      "business_unit_id", "TEXT NOT NULL DEFAULT 'default'");
ensureTableColumn(db, "crm_activities",    "business_unit_id", "TEXT NOT NULL DEFAULT 'default'");
```

`ADD COLUMN ... NOT NULL DEFAULT 'default'` backfills every pre-existing row to
the default business unit atomically — no separate backfill pass. The FK +
`ON DELETE CASCADE` are deferred to Phase 3 for the SQLite reason above. Child /
join tables inherit scope through their parent FK and get **no** column.

**3. Per-business-unit contact lifecycle as an additive overlay**
(`crm_contact_business_unit_profiles`, composite PK `(contact_id,
business_unit_id)`). This is what lets a contact be a lead in one business unit
and active in another **without** re-keying the existing
`crm_contact_profiles` table — a re-key would force a full table rebuild and
break every `ON CONFLICT(contact_id)` upsert. The legacy table and its upserts
are untouched. The overlay carries the **same integrity CHECKs** as the base
profile table (lifecycle / relationship_health / priority / owner_type enums, and
the owner_type↔owner_id pairing CHECK), so the per-tenant row cannot hold weaker
data than the global one.

**4. Cross-file instance pointer** (`src/router/router-db.ts`):

```sql
ALTER TABLE instances ADD COLUMN crm_business_unit_id TEXT;  -- nullable, NO FK
```

No foreign key — `instances` is in `ravi.db`, `crm_business_units` in `chat.db`;
a cross-file SQLite FK is impossible and an inline `REFERENCES` would crash the
router at prepare time. Unmapped instances stay `NULL` and resolve to the default
business unit. The migration guards on `PRAGMA table_info` and logs via the
structured logger.

Diffstat: `src/contacts.ts` (+57), `src/router/router-db.ts` (+16), two test
files (+252), CI wiring in `package.json` (±1 line), spec (+593).

## Expected Behavior

- **Today / after Phase 1:** identical to before. There is exactly one (default)
  business unit; every existing and new commercial row carries
  `business_unit_id = 'default'`; every instance resolves to it. No CLI output,
  no read, no write changes. The migration is safe on a populated production DB.
- **After Phase 2 (not in this PR):** all scoped CRM access flows through a
  fail-closed resolver. Still one business unit, so still no visible change — the
  guardrail simply exists.
- **After Phase 3 (not in this PR):** operators create a second business unit and
  remap an instance (`ravi crm business-unit create/assign`). The first real
  isolation boundary appears; the default-pipeline uniqueness index is swapped to
  per-business-unit and the deferred FKs are added in the same explicit rebuild.

The phasing guarantees that no single step changes behavior until an operator
**explicitly** opts an instance into its own business unit.

## Validation & Test Evidence

Two focused suites ship with the schema and run in CI:

- `src/contacts.crm-business-units.test.ts` (7 tests): seeds exactly one default
  business unit; asserts `business_unit_id` is `NOT NULL DEFAULT 'default'` on all
  five commercial tables; **backfills a faithful pre-migration legacy row** to the
  default; rejects a second `is_default = 1` via the partial index; verifies the
  overlay's composite PK; asserts the overlay enforces the same enum/owner CHECKs
  as the base table; and proves idempotency across re-open.
- `src/router/router-db.crm-business-unit.test.ts`: asserts the nullable
  `crm_business_unit_id` pointer is added to `instances` and the migration is
  idempotent.

The contacts suite was added to the curated CI chain (`package.json` `test`
script) so it executes on every CI run, not just under full local discovery.

**Baseline disclosure (important for the reviewer):** the `dev` branch's curated
test chain is already red at a pre-existing baseline (37 failures in
`src/tasks/` / `src/projects/` unrelated to CRM). This PR's change set produces a
**byte-identical** failure set — i.e. **zero new regressions**; the CRM suites
themselves are green. The failures are inherited from `dev`, not introduced here.

## Risks & Known Limitations

- **App-layer enforcement is leakier than RLS.** Because SQLite has no row-level
  security, isolation depends on the Phase 2 resolver discipline. Mitigation: a
  single fail-closed guard + a static check asserting no scoped `crm_*` query
  omits the business-unit predicate (specified, lands with Phase 2).
- **Deferred FKs.** Until Phase 3, `business_unit_id` on the five tables is a bare
  `NOT NULL` column without referential enforcement. This is a conscious SQLite
  trade-off, documented in the spec's Migration Mechanism section.
- **HITL gates.** Any schema change is HITL-gated (AGENTS.md C.15). Phase 1's diff
  is presented for explicit approval; Phases 2–3 are separate, separately-gated
  PRs.

## References

- Canonical spec (normative): `.ravi/specs/contacts/crm/instance-isolation/SPEC.md`
- Migration mechanism & SQLite `ALTER` boundary: spec § Migration Mechanism
- Market mapping & open decisions: spec § Market Mapping, § Open Decisions
