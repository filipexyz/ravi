---
id: onboarding
title: "Ravi Onboarding & Architect"
kind: domain
domain: onboarding
capabilities:
  - architect
  - recipes
  - intent-mapping
  - plan-execution
tags:
  - onboarding
  - architect
  - automation
  - setup
applies_to:
  - src/plugins/internal/ravi-system/skills/architect
  - src/cli/commands
  - .ravi/recipes
  - .ravi/profiles
owners:
  - ravi-dev
status: draft
normative: true
---

# Ravi Onboarding & Architect

## Intent

Ravi onboarding is the path from "user just connected a channel" to "user has a tailored Ravi setup running on autopilot for their actual goal".

The Architect is the meta-capability inside this domain: it interviews the user, inspects what already exists, picks or composes a *recipe*, generates a versionable *plan*, and executes the plan one primitive at a time, producing specs and task profiles along the way so the resulting setup remains auditable and reproducible.

Other domain skills (contacts, tag-rules, observers, instances, crm) are vertical and operational. The Architect is horizontal and compositional. It does not replace them; it orchestrates them.

## Boundaries

- Architect MUST only use existing Ravi primitives (agents, instances, routes, tag rules, observer rules, observer profiles, reading lists, task profiles, cron jobs, triggers, specs). It MUST NOT invent new tables or storage layers.
- Architect MUST NOT execute irreversible operations without explicit user authorization (delete agent, drop instance, force-tag a base of contacts, blast outbound messages).
- Architect MUST always produce a written *plan artifact* before execution. The plan MUST be auditable independently from the conversation that produced it.
- Architect MUST produce a *spec artifact* describing the resulting setup so a future operator (human or agent) can recover the intent without re-interviewing the user.
- Architect MUST produce or reference *task profiles* for any recurring work (periodic ticks, follow-ups, weekly reports) so cron and operators have a defined surface to invoke.
- AI/LLM-driven interpretation lives only in the discovery and mapping phases. Plan generation, dependency resolution, and execution MUST be deterministic given the same inputs.

## Stages

The Architect operates in four sequential stages. Each stage MUST be persisted as a task with its own task profile so the user can pause and resume across sessions.

### 1. Discover

- Inspect current Ravi state across the 5 operational planes (identity, ledger, instance config, classification, action).
- Conduct a short structured interview: goal trail (sales / support / personal / curation / custom), priority surfaces (which channels), team shape (solo / multi-agent), confidence level (auto vs operator-in-the-loop).
- Output: a `discovery.md` artifact summarizing user intent in natural language plus a structured snapshot of the current state.

### 2. Map

- Match the discovered intent against the *recipe catalog*. A recipe is a declarative bundle of primitives (instances + tags + rules + observers + profiles + cron jobs + specs) tagged with the goal trail and surface coverage.
- If no recipe fits, the Architect MAY compose a custom recipe by combining smaller building blocks. Composition MUST resolve primitives in topological order so dependencies are obvious before the user reviews the plan.
- Output: a `mapping.md` artifact listing the chosen recipe(s), missing parameters (slugs, names, agent identities), and the primitives that will be created or updated.

### 3. Plan

- Convert the mapping into a deterministic plan: ordered list of atomic operations with kind, target, action (`create | update | enable | disable | bind | unbind`), reversibility flag, dependency edges, and required user inputs.
- The plan MUST be saved as a versioned artifact (kind `architect-plan`) so subsequent runs can detect drift.
- The plan MUST be reviewable as a single Markdown document AND machine-readable JSON.
- Output: `plan.md` + `plan.json` artifacts. User reviews and approves, either whole or per slice.

### 4. Execute

- Run the plan one atomic operation at a time. Between operations, surface the resulting state ("instance X is now intake=discovered with default tag Y").
- Pause for explicit confirmation before any non-reversible operation.
- On failure: roll back operations that are reversible, mark the others as `requires_manual_review`, and write a `recovery.md` artifact for the user to follow.
- After success: write a `spec.md` for the user's setup so the configuration survives outside the chat, plus any task profiles needed for recurring work (weekly tick, cron jobs, observer schedules).
- Output: registered primitives in the DB, an `architect-run` artifact with full audit trail, and zero or more new task profiles and specs under the user's workspace.

## Recipe Model

Recipes live as JSON manifests under `.ravi/recipes/<id>.json` (version-controlled) or in a database registry for runtime-edited recipes.

A recipe MUST declare:

```yaml
id: <slug>
title: <human label>
goal: <one of sales | support | personal | curation | custom>
surfaces: [whatsapp | telegram | discord | matrix | ...]
description: <free text>
inputs:
  - name: <param>
    label: <prompt>
    kind: <slug | identifier | enum | text | bool>
    required: <bool>
    default: <value or null>
primitives:
  - kind: <instance | agent | route | tag-rule | observer-rule | observer-profile | reading-list | task-profile | cron-job | spec>
    action: <create | update | reference>
    spec: <inline definition or path>
    requires: [<other primitive id>]
notes: <free text guidance for the operator>
```

Recipes MUST be composable: a `sales-pipeline-basic` recipe references the `triage-observer` recipe, which references the `default` observer profile, etc.

Recipes MUST be reversible: each recipe MUST declare an inverse operation set so the Architect can offer an "undo" pass.

## Plan Model

Plans are produced from recipes + user inputs + current-state diff. The plan format MUST satisfy:

- atomic operations with stable ids;
- dependency edges so the executor can topologically order them;
- reversibility flags so the executor can short-circuit non-reversible ops for explicit confirmation;
- per-op evidence: which recipe item produced this op, which user input filled which slot;
- annotations for items that will produce new specs or task profiles (and where they will live).

The plan is serialized as both Markdown (human review) and JSON (machine execution).

## Task Profiles Produced

Every Architect run MAY produce zero or more task profiles in the user's workspace. The most common are:

- `<recipe>-weekly-tick` — runs `ravi tag-rules tick --apply` and reports drift.
- `<recipe>-followup-batch` — runs follow-up actions for a tag cohort.
- `<recipe>-content-digest` — runs curated content delivery for a reading list.

Task profiles produced by the Architect MUST:

- be marked with `metadata.source: architect`;
- include a `dependsOnSpec` field pointing to the user's setup spec;
- declare their input contract clearly so cron jobs can invoke them without ambiguity.

## Spec Output

Every Architect run that creates or modifies primitives MUST emit a setup spec at `.ravi/specs/onboarding/runs/<run-id>/SPEC.md`. The spec MUST capture:

- the user's intent in their words;
- the recipe chosen and the inputs given;
- the final list of primitives created or updated, with ids;
- the next maintenance actions (cron jobs, follow-up tasks);
- the inverse operation set, so a future operator can dismantle the setup if needed.

The setup spec is the source of truth for "why does this Ravi configuration exist?".

## Invariants

- The Architect MUST be idempotent: running it twice with the same recipe and same inputs MUST produce the same plan and the same final state.
- Plan execution MUST be deterministic from the plan artifact alone — no LLM calls during execution, only primitive CLI invocations and pre-decided parameters.
- No primitive MUST be created without a corresponding entry in the plan and the spec.
- User-confirmable operations MUST be batched only when they share the same recipe and same risk class.
- Failures MUST leave the system in a state described by `recovery.md`; never leave silent partial setups.
- The recipe catalog MUST live in version control. Runtime-only recipes are forbidden until a sync mechanism exists.

## CLI Surface

The Architect SHOULD eventually expose:

```bash
ravi architect discover [--goal sales|support|...] [--surfaces whatsapp,telegram]
ravi architect recipes list
ravi architect recipes show <id>
ravi architect plan --recipe <id> [--input key=value ...]
ravi architect plan show <run-id>
ravi architect execute <run-id> [--apply] [--from <step>] [--until <step>]
ravi architect runs list
ravi architect runs show <run-id>
ravi architect undo <run-id>
```

All commands MUST emit JSON when invoked with `--json` so agents and operators can pipe them.

## Acceptance Criteria

- A user can request "configurar atendimento comercial" and get a runnable plan within one turn, with concrete primitives and a clear list of inputs needed.
- A plan can be approved per slice or in full, and execution proceeds step by step with confirmation gates on non-reversible operations.
- After execution, the user has a saved spec describing their setup and at least one task profile for ongoing maintenance.
- Re-running the same recipe with the same inputs is a no-op (idempotent).
- `ravi architect undo <run-id>` reverts the reversible operations and reports which steps require manual review.
- Recipes are versioned in `.ravi/recipes` and validated before listing.

## Known Failure Modes

- **Plan drift**: recipe changed after plan was generated; executor MUST detect and refuse to run stale plans.
- **Silent overwrites**: existing user primitives renamed or merged without disclosure; MUST be flagged in the plan with explicit conflict resolution choices.
- **Recipe over-reach**: recipe touches primitives the user did not consent to (e.g., editing other instances); recipes MUST declare scope.
- **Spec rot**: setup spec not kept in sync after manual edits; the spec MUST be regenerated when `architect runs reconcile` is invoked.
- **Cron orphan**: cron job pointing at a deleted task profile; undo MUST remove cron entries first.
- **LLM-in-execution**: any code path that uses model inference during execution; forbidden by the deterministic-execution invariant.
