---
id: doctor
title: "Ravi Doctor"
kind: domain
domain: doctor
capabilities:
  - output
  - check-catalog
  - runtime-health
  - security-drift
tags:
  - doctor
  - health
  - governance
  - cli
  - observability
applies_to:
  - src/cli/commands/doctor.ts
  - src/cli/registry-snapshot.ts
  - src/cli/decorators.ts
  - src/router
  - src/permissions
  - src/costs
  - src/apps
  - src/skills
  - .ravi/specs
owners:
  - dev
status: draft
normative: true
---

# Ravi Doctor

Status: draft
Owner: dev
Last updated: 2026-06-08

## Intent

`ravi doctor` is the local health, drift, and governance preflight for Ravi.

It MUST give operators and agents one typed summary of whether Ravi is broken,
unsafe, drifting, or merely reporting context. It SHOULD compose existing
validators instead of duplicating their logic.

## Severity Model

Doctor findings MUST use exactly these severities:

- `error`: broken or insecure. The system is likely failing, leaking access, or
  unable to execute a required path safely.
- `warn`: operational drift. The system can run, but state, metadata, coverage,
  or policy is stale, broad, ambiguous, or incomplete.
- `info`: snapshot, coverage, or context. Informational findings MUST NOT make
  the command fail.

`error` findings MUST make the default command exit non-zero. `warn` findings
MAY make the command exit non-zero only when strict mode is requested.

## Boundaries

`ravi doctor` MUST be read-only.

It MUST NOT:

- create, update, delete, approve, route, migrate, grant, revoke, restart, or
  deploy anything;
- expose raw credentials, context keys, provider tokens, env values, or secret
  payloads;
- depend on a live provider call when a local deterministic check can answer
  the question;
- block local checks because one network or provider check timed out.

It MAY:

- inspect local SQLite state;
- call read-only Ravi commands with typed JSON output;
- run timeout-bounded live health checks;
- report skipped or unavailable checks with evidence.

## Entity Model

Doctor checks MUST use Ravi semantic entities in findings:

- `agent`
- `session`
- `chat`
- `route`
- `contact`
- `platform_identity`
- `actor`
- `instance`
- `permission_relation`
- `cost_event`
- `spec`
- `skill`
- `app`

Raw channel ids, provider ids, phone numbers, JIDs, and external ids MAY appear
only as provenance in `data` or evidence fields. They MUST NOT be the primary
entity label when a Ravi entity exists.

## Output Contract

`ravi doctor --json` MUST return the typed contract defined by
`doctor/output`.

Human output SHOULD be compact by default and grouped by severity:

1. summary;
2. `error` findings;
3. `warn` findings;
4. short `info` snapshot.

`--full` SHOULD include all `info` findings and domain snapshots.

Every non-passing check SHOULD include:

- stable finding id;
- severity;
- domain;
- short title;
- summary;
- evidence;
- fix hint when an obvious safe next step exists.

## Initial Domains

Doctor MUST start with these domains.

### Apps, Specs, And Skills

Doctor SHOULD detect:

- spec drafts that apply to production code;
- skills referencing missing specs;
- invalid app manifests;
- registry drift where only the meta-app is available locally while app state
  contains additional apps.

### Permissions

Doctor SHOULD detect:

- public commands that are mutating but have no explicit permission metadata;
- mutating commands without a guard or grant model;
- missing grants for expected operational commands;
- broad grants such as `admin system:*`, `use tool:*`, `execute executable:*`,
  or `execute group:*`;
- permanent grants without a reason when the grant was not legacy/bootstrap
  state;
- orphan grant subjects or objects.

The command registry SHOULD grow explicit metadata for mutation, risk, required
permission, and guard source. Until that exists, heuristic detection MUST be
reported as `warn`, not `error`, unless a missing guard is proven.

### Costs

Doctor SHOULD detect:

- providers or models with usage but no price;
- stale pricing catalog;
- incomplete `cost_events` rows;
- inconsistent pricing metadata for the same provider/model.

### Runtime

Doctor SHOULD detect:

- daemon offline;
- daemon and CLI version mismatch;
- wrong cwd or bundle mismatch;
- branch drift against the configured base branch;
- dirty worktree when running in a release/deploy context;
- missing migration ledger or unverifiable schema state.

Runtime process names MUST be normalized before reporting failures, so legacy
PM2 names do not create false positives when the renamed process is healthy.

### Sessions And Routes

Doctor SHOULD detect:

- routes pointing to missing agents;
- routes pointing to missing instances;
- duplicate effective routes;
- sessions pointing to missing agents;
- sessions stuck in error or aborted state;
- eligible chats without a route.

### Channels And Omni

Doctor SHOULD detect:

- enabled instances that are disconnected;
- providers without a health signal;
- inbound messages without resolved actor metadata;
- inbound messages without resolved contact or agent metadata;
- channel state that still relies on raw provider ids as the primary routing
  identity.

## Composition

Doctor SHOULD compose existing validators and snapshots, including:

- `ravi apps check --json`;
- `ravi sdk returns validate --json`;
- `ravi costs pricing --json`;
- `ravi daemon status --json`;
- route, session, instance, and permission read-only services.

Validators MAY also remain runnable independently. Doctor is an aggregator and
triage surface, not the only owner of each domain rule.

## Non-Goals

Doctor does not replace:

- test suites;
- build/typecheck gates;
- migrations;
- provider reconnection;
- permission repair commands;
- pricing recomputation;
- route cleanup.

Doctor reports what is wrong and why. Operators or agents choose the repair
workflow explicitly.
