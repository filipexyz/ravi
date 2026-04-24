# Ravi Specs Memory PRD

## Summary

Ravi needs a versioned business-rules memory system so agents can consult feature expectations before changing code. The structure should leave room for later audits, but v1 should focus on explicit retrieval and maintenance.

The first version should introduce `ravi specs`: a filesystem-first Markdown registry under `.ravi/specs/`, with a CLI that can list, get, create, index, and link specs to Projects. Specs are memory by default, not blockers. They guide agents, surface drift, and create follow-up work when rules are violated.

## Problem

Important product and runtime rules currently live in chat history, incident reports, scattered docs, tests, and operator memory. This creates recurring failure modes:

- Agents repeat mistakes because the relevant rule was not in their immediate context.
- Fixes encode local behavior without recording the broader invariant.
- Review depends on whoever remembers the original decision.
- Related features drift because there is no project-aware rule surface to audit.
- Tests cover examples, but not always the product intent behind those examples.

Recent examples:

- Presence lifecycle rules were clarified through multiple incidents before becoming concrete.
- Restart notification context regressed because the invariant was implicit.
- Overlay live assistant threading needed runtime-item semantics, but the rule was not documented as a feature expectation.

## Goals

- Store feature/business rules as durable, reviewable memory.
- Let agents retrieve the composed rule context for a domain, capability, or feature.
- Link specs to Projects without making Projects own the rules directly.
- Leave room for future audits without implementing audit flow in v1.
- Keep the first version simple enough to use immediately.
- Keep the knowledge structure easy to maintain as it grows.

## Non-Goals

- Do not build a policy engine in v1.
- Do not block CI or agent execution by default.
- Do not make SQLite the source of truth for spec content.
- Do not put `project_id` directly on specs or tasks.
- Do not replace tests, docs, task profiles, or Projects.

## Core Concepts

### Spec

A spec is a Markdown document that captures operational memory for a domain, capability, or feature.

Specs are advisory memory by default. They can later gain severity or enforcement metadata, but v1 should not block execution.

### Hierarchy

Specs live in a three-level hierarchy:

```text
.ravi/specs/
  <domain>/SPEC.md
  <domain>/<capability>/SPEC.md
  <domain>/<capability>/<feature>/SPEC.md
```

Example:

```text
.ravi/specs/
  channels/
    SPEC.md
    presence/
      SPEC.md
      lifecycle/
        SPEC.md
  runtime/
    SPEC.md
    continuity/
      SPEC.md
      session-resume/
        SPEC.md
```

### Domain

A broad system area, such as `runtime`, `channels`, `overlay`, `tasks`, `projects`, `images`, or `sessions`.

Domain specs define ownership, boundaries, vocabulary, and top-level invariants.

### Capability

A cross-cutting capability inside or across domains, such as `presence`, `continuity`, `reporting`, `timeline`, or `delivery`.

Capability specs define behavior shared by multiple features.

### Feature

A concrete behavior or product slice, such as `lifecycle`, `session-resume`, `report-delivery`, or `assistant-threading`.

Feature specs define exact expectations, edge cases, regressions, and validation commands.

### Composed Spec Context

When requesting a feature spec, the CLI composes all inherited levels:

```bash
ravi specs get channels/presence/lifecycle
```

Output includes:

1. `.ravi/specs/channels/SPEC.md`
2. `.ravi/specs/channels/presence/SPEC.md`
3. `.ravi/specs/channels/presence/lifecycle/SPEC.md`

This makes the hierarchy useful as inherited context, not just taxonomy.

## Knowledge Architecture

The system should use four lightweight methodologies together:

- **Diataxis** to separate types of knowledge instead of mixing everything into one file.
- **KCS (Knowledge-Centered Service)** to keep specs alive during incident/debug/fix work.
- **Docs-as-code** to make specs versioned, reviewable, searchable, and testable.
- **RFC 2119 / BCP 14 language** to make requirements clear enough for agents and auditors.

This is not a development methodology. It is the maintenance model for the knowledge base.

### Diataxis-Inspired File Types

Each hierarchy node can contain multiple Markdown files, each with a narrow job:

```text
.ravi/specs/
  <domain>/
    SPEC.md
    WHY.md
    RUNBOOK.md
    CHECKS.md
    <capability>/
      SPEC.md
      WHY.md
      RUNBOOK.md
      CHECKS.md
      <feature>/
        SPEC.md
        WHY.md
        RUNBOOK.md
        CHECKS.md
```

File roles:

- `SPEC.md` captures rules, invariants, expected behavior, boundaries, and acceptance criteria.
- `WHY.md` captures rationale, tradeoffs, rejected alternatives, and ADR-like decisions.
- `RUNBOOK.md` captures operational/debug procedures.
- `CHECKS.md` captures validation commands, audit queries, and regression scenarios.

Only `SPEC.md` is required in v1. The other files are optional but standardized.

### Normative Language

Specs should distinguish hard rules from guidance:

- `MUST` means required invariant.
- `MUST NOT` means forbidden behavior.
- `SHOULD` means expected default with explicit exceptions allowed.
- `MAY` means optional behavior.

Agents and auditors should treat `MUST` and `MUST NOT` as the highest-priority rules.

### KCS Maintenance Loop

Every incident, bug fix, or repeated confusion should update the knowledge base:

1. Capture the observed failure.
2. Identify the rule that should have prevented it.
3. Update or create the affected `SPEC.md`.
4. Add debug/validation steps to `RUNBOOK.md` or `CHECKS.md`.
5. Link the spec to the relevant Project, task, artifact, or incident.

This turns debugging into knowledge compounding instead of one-off memory.

### Docs-as-Code Governance

Specs live in Git and should follow the same quality bar as code:

- Markdown source of truth.
- Reviewable diffs.
- Owners in frontmatter.
- Linkable from Projects and tasks.
- Generated index/cache only as rebuildable output.
- CI checks for broken links, invalid frontmatter, duplicate ids, and missing required fields.

No generated spec registry should be committed unless it is explicitly a packaged build artifact.

## Spec File Format

Each `SPEC.md` should be Markdown with YAML frontmatter.

Example:

```md
---
id: channels/presence/lifecycle
title: Presence Lifecycle
kind: feature
domain: channels
capabilities:
  - presence
  - runtime-lifecycle
tags:
  - gateway
  - typing
applies_to:
  - src/gateway.ts
  - src/omni/typing-presence.ts
owners:
  - dev
status: active
normative: true
---

# Presence Lifecycle

## Intent

Presence should communicate real active work. It must not make idle sessions look alive.

## Invariants

- Silent responses MUST stop presence immediately.
- Terminal runtime events MUST stop presence.
- Late stream/runtime events MUST NOT reactivate an ended turn.
- Only a new turn start MAY reactivate presence.

## Validation

- `bun test src/gateway-session-trace.test.ts src/omni/typing-presence.test.ts`

## Known Failure Modes

- Post-delivery renewal firing after a final response.
- Runtime activity events arriving after terminal events.
```

Optional companion files can be added next to the spec:

```text
WHY.md
RUNBOOK.md
CHECKS.md
```

The CLI should always treat `SPEC.md` as the canonical rules file. Companion files enrich context when requested or when composing full context.

## CLI Surface

### MVP Commands

```bash
ravi specs list
ravi specs list --domain channels --kind feature
ravi specs get channels/presence/lifecycle
ravi specs get channels/presence/lifecycle --mode full
ravi specs get channels/presence/lifecycle --mode checks
ravi specs new channels/presence/lifecycle --title "Presence Lifecycle" --kind feature
ravi specs new channels/presence/lifecycle --title "Presence Lifecycle" --kind feature --full
ravi specs sync
```

Expected behavior:

- `list` scans `.ravi/specs`, reads frontmatter, and prints known specs.
- `get` returns inherited context from domain to feature.
- `get --mode rules` returns inherited `SPEC.md` files. This is the default.
- `get --mode full` includes optional `WHY.md`, `RUNBOOK.md`, and `CHECKS.md` files.
- `get --mode checks` returns validation/check context.
- `get --mode why` returns rationale/decision context.
- `get --mode runbook` returns operational/debug context.
- `new` creates missing directories and starter files.
- `new --full` creates `SPEC.md`, `WHY.md`, `RUNBOOK.md`, and `CHECKS.md`.
- `sync` rebuilds the SQLite index from files.

### Project Integration

Projects already support polymorphic links through `project_links`.

Add `spec` as a valid project link asset type:

```bash
ravi projects link spec ravi-core channels/presence/lifecycle --meta '{"context":true,"audit":true}'
```

Meaning:

- `context: true` means the spec should be considered relevant context for agents working on the project.
- `audit: true` means periodic auditors may validate the spec against project resources.

Do not add direct project ownership columns to specs.

## Storage

### Source of Truth

Markdown files under `.ravi/specs/`.

Why:

- Reviewable in PRs.
- Easy to diff.
- Easy for agents and humans to read.
- Does not disappear if SQLite is rebuilt.

### Index / Cache

SQLite can store a rebuildable index:

- `id`
- `path`
- `kind`
- `domain`
- `capabilities_json`
- `feature`
- `title`
- `tags_json`
- `applies_to_json`
- `owners_json`
- `status`
- `mtime`
- `updated_at`

SQLite must not be required to recover spec content.

## Agent Behavior

Agents should use specs in two ways in v1:

1. Before implementation: retrieve explicit specs by id.
2. During review: compare code changes against explicit spec context.

If specs conflict, agents should report the conflict instead of guessing.

## Deferred Audit Model

Future audits should be advisory by default.

An audit result should capture:

- spec id
- project id or resource locator
- checked files
- findings
- severity: `info`, `warn`, `risk`
- evidence
- suggested next action

Audit commands are explicitly out of the MVP. Future audit findings can later become tasks or artifacts.

## Acceptance Criteria

- A user can create `.ravi/specs/channels/presence/lifecycle/SPEC.md` through the CLI.
- A user can list specs from the CLI.
- A user can get one spec context with inherited domain + capability + feature rules.
- A user can request `rules`, `full`, `checks`, `why`, or `runbook` context modes.
- `ravi projects link spec <project> <spec-id>` works and stores metadata in `project_links`.
- Specs remain readable without SQLite.
- `ravi specs sync` can rebuild the index from Markdown.

## MVP Implementation Scope

The first implementation should cover explicit memory operations only:

- `src/specs` service for path normalization, Markdown parsing, list/get/new/sync, and SQLite reindex.
- `ravi specs list|get|new|sync`, all with `--json`.
- `ravi projects link spec ...`, validating that the target spec exists.
- Internal skill `ravi-system-specs`.
- Tests for path validation, inherited context, companion files, JSON output, sync rebuild, and project linking.

## Deferred Gaps

### Prompt Injection

Automatic prompt injection is deferred.

Reason: the system does not yet have a clear selected spec scope for every session/task. Injecting too much would turn specs into prompt noise.

### Search / Discovery

Commands like `find`, `for-file`, `for-project`, or ranked matching are deferred.

Reason: we first need real specs and usage patterns before designing discovery.

### Audit Runner

Commands like `ravi specs audit`, `ravi specs check`, and `ravi specs violations` are deferred.

Reason: the user explicitly does not need audit flow in this phase.

### Seed Specs

The system only becomes useful if the first specs capture the incidents that motivated it.

Recommended seed specs:

- `channels/presence/lifecycle`
- `daemon/restart/context-preservation`
- `overlay/chat/assistant-threading`
- `runtime/continuity/session-resume`
- `tasks/reporting/delivery`

## Open Questions

- Should v1 create starter domain and capability specs automatically when adding a feature spec?
- Should `get --mode full` include related specs from frontmatter later, or only hierarchy?
- Should project-linked specs be displayed in `ravi projects show/status` immediately?
- Should spec IDs always mirror paths, or can frontmatter alias them?

## Proposed MVP Sequence

1. Add `spec` to project link asset types.
2. Add `src/specs` service for filesystem scan, parse, list, get, new, and sync.
3. Add `ravi specs` CLI.
4. Add minimal SQLite index.
5. Add tests for path resolution, inherited context, sync rebuild, and project linking.
6. Create first real specs for presence lifecycle and restart context preservation.
