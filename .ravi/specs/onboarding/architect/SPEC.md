---
id: onboarding/architect
title: "Ravi Architect"
kind: capability
domain: onboarding
capability: architect
capabilities:
  - architect
  - intent-mapping
  - plan-execution
tags:
  - onboarding
  - architect
  - automation
applies_to:
  - src/plugins/internal/ravi-system/skills/architect
  - .ravi/recipes
  - .ravi/profiles
owners:
  - ravi-dev
status: draft
normative: true
---

# Ravi Architect

## Intent

The Architect is the conversational + deterministic capability that translates an operator's intent into a working Ravi setup composed from existing primitives. It MUST stay reproducible: same intent + same inputs → same setup.

Architect is the only Ravi capability that orchestrates other domains in bulk. Every other skill is vertical; Architect is the integration plane.

## Lifecycle of a Run

A run progresses through fixed stages, each backed by a task with its own profile:

1. **discover** — read state, interview user
2. **map** — pick / compose a recipe
3. **plan** — produce ordered atomic operations
4. **execute** — run the plan with confirmation gates
5. **finalize** — emit setup spec + task profiles + cron entries

Each stage MUST end with an artifact persisted under `.ravi/architect/runs/<run-id>/` (or equivalent state dir):

- `discovery.md` + `discovery.json`
- `mapping.md` + `mapping.json`
- `plan.md` + `plan.json`
- `execute.log.json`
- `setup-spec.md`

Runs are addressable by `run-id`. Reading lists, observers, and cron jobs created by a run MUST tag back to the run id via `metadata.architectRunId`.

## Discover Stage

Goal: capture enough context to choose a recipe without making the user fill a 20-question form.

Inputs MUST include:

- explicit user statement of goal (free text)
- selected goal trail (sales | support | personal | curation | custom)
- surfaces in use (whatsapp | telegram | discord | matrix | email | ...)
- operator-in-the-loop level (auto | review | manual)

State snapshot MUST cover the 5 operational planes:

- instances (intake mode, default tags, connection status)
- contacts (counts by status)
- chats (totals, DMs vs groups)
- classification (existing tag rules)
- action (existing observer rules, agents)

The Discover artifact MUST be human-readable; it is the contract between the user and the Architect for what they asked for.

## Map Stage

Goal: deterministic match from intent to recipe(s).

Mapping MUST be a pure function of:

- discovery artifact
- recipe catalog version

Match rules:

- Exact goal-trail match takes precedence.
- Surface coverage MUST be a non-empty intersection.
- If multiple recipes match, prefer fewer primitives (minimum viable setup).
- If no recipe matches, the Architect MAY compose a custom recipe from declared building blocks; the composition MUST be persisted as a new recipe under the user's workspace before planning.

Mapping artifact MUST list:

- recipe ids chosen
- inputs the user still needs to provide
- diff between recipe primitives and current state (will create / will update / will skip)

## Plan Stage

Goal: produce a deterministic, idempotent plan.

The plan MUST:

- have stable operation ids derived from recipe + input slot + target id;
- declare reversibility per operation (reversible | irreversible | requires-confirmation);
- declare dependency edges so executor topologically orders ops;
- annotate each op with its origin recipe item;
- list which artifacts (specs, task profiles) the run will emit downstream.

Plan execution MUST be possible offline from the plan artifact alone — no LLM, no recipe lookup, only deterministic primitive invocations.

## Execute Stage

Goal: realize the plan with safety.

Rules:

- Reversible ops MAY run unattended in batch (default: 5 ops per batch with a 2-second visual pause).
- Irreversible ops MUST pause for confirmation; the operator sees the exact CLI invocation that will run.
- After each batch, the Architect MUST verify the resulting state with read commands and report the diff.
- On failure: stop the batch, roll back reversible ops applied since the last confirmation boundary, write `recovery.md` describing the surviving state and the next manual step.

State is persisted after every op so the run can resume.

## Finalize Stage

Goal: leave the user with durable assets.

MUST produce:

- a setup spec at `.ravi/specs/onboarding/runs/<run-id>/SPEC.md` summarizing the user's intent, the recipe, the inputs, and the final primitives;
- zero or more task profiles in the user workspace marked with `metadata.source: architect` and `metadata.architectRunId`;
- zero or more cron entries pointing at the task profiles, registered via the existing `ravi cron` primitive;
- a `summary.md` artifact that links discovery → mapping → plan → execute → setup spec.

## Idempotence

Re-running `ravi architect plan --recipe X --input k=v...` with the same inputs against the same state MUST produce a plan with zero operations. The Architect uses the setup spec from previous runs to detect that the state already matches.

A change of recipe version MUST invalidate previous runs only if the change introduces new primitives or changes inverse operations. Recipes MUST declare a semantic version.

## Undo

`ravi architect undo <run-id>` MUST:

- traverse the run's plan in reverse order;
- apply the inverse operation for each reversible op;
- collect non-reversible ops in `requires-manual-review.md`;
- mark the run as `undone` in its summary;
- prompt the user to verify before undoing primitives that other runs may depend on (e.g., a shared agent).

The setup spec MUST be archived (not deleted) so audit history survives undo.

## Invariants

- Discover, Map, and Plan stages MAY use LLM-driven interpretation. Execute and Undo stages MUST NOT.
- Every primitive created or updated by the Architect MUST be tagged with `architectRunId` in its metadata.
- A run that did not finalize MUST NOT leave dangling primitives without a `recovery.md`.
- Plans MUST be content-addressable: a `plan.json` with the same hash describes the same intended state regardless of which Architect run produced it.
- The Architect MUST refuse to operate on shared primitives (e.g., default agents, system tags) without explicit override flags.

## Validation

- `bun test src/onboarding/architect/*.test.ts`
- `ravi architect recipes validate`
- `ravi architect plan --recipe sales-pipeline-basic --dry-run` produces a non-empty plan
- `ravi architect runs list` shows runs with stable ids

## Acceptance Criteria

- Discover stage can be skipped by passing a `--goal` flag; it MUST still produce a `discovery.json` for audit.
- Plan stage produces both `plan.md` and `plan.json` with identical operation lists.
- Execute stage halts on irreversible ops and emits confirmation prompts; with `--apply` it proceeds non-interactively only after explicit `--non-interactive` flag.
- Finalize stage writes a setup spec readable by `ravi specs get onboarding/runs/<run-id>`.
- Undo stage successfully reverts a freshly executed run, leaving the state byte-equivalent to pre-run.

## Known Failure Modes

- **Partial finalize**: spec written but task profiles missing → next run sees inconsistent state and refuses to plan.
- **Cron registered but profile absent**: cron fires and fails; finalize MUST register cron AFTER profile is materialized.
- **Run id collision**: two operators planning at the same time produce the same id → run ids MUST be UUIDs, not slugs.
- **Recipe imports another recipe but not at the same version**: pinned via semver `requires`, MUST refuse if missing.
- **Confirmation fatigue**: user clicks through irreversible ops without reading → group irreversible ops by recipe item and show a single condensed confirmation per group.
