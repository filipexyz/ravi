---
id: doctor/check-catalog
title: "Doctor Check Catalog"
kind: capability
domain: doctor
capability: check-catalog
tags:
  - doctor
  - checks
  - catalog
  - governance
applies_to:
  - src/cli/commands/doctor.ts
  - src/permissions
  - src/router
  - src/costs
  - src/apps
  - src/skills
  - src/specs
owners:
  - dev
status: draft
normative: true
---

# Doctor Check Catalog

Status: draft
Owner: dev
Last updated: 2026-06-08

## Intent

The doctor check catalog defines the stable check ids and finding ids used by
`ravi doctor`.

Each check SHOULD be implemented as a pure, read-only module that returns typed
check results and findings.

## Check Definition

Each check MUST declare:

- `id`: stable machine id;
- `domain`: one doctor domain;
- `title`: human title;
- `defaultSeverity`: `error`, `warn`, or `info`;
- `mode`: `local`, `live`, or `composed`;
- `timeoutMs` when live or composed;
- dependencies or commands it composes;
- evidence fields it emits;
- redaction policy when data may contain sensitive values.

Checks MUST NOT mutate state.

## Apps, Specs, And Skills

Initial checks:

- `apps.manifest.invalid`
- `apps.registry.meta_only`
- `specs.draft_applies_to_production`
- `skills.spec_reference_missing`
- `sdk.returns.missing_public`
- `sdk.returns.weak_public_new`

Expected severity:

- invalid app manifests SHOULD be `error` when the app is installed/enabled;
- meta-only app registry drift SHOULD be `warn` or `info` based on whether the
  missing app is expected in source control;
- draft specs applying to production code SHOULD be `warn`;
- missing skill spec references SHOULD be `warn`, or `error` if the skill is
  installed and required by active runtime prompts;
- missing public return schemas SHOULD be `error`;
- new weak public return schemas SHOULD be `warn` until the SDK spec upgrades
  the gate to `error`.

## Permissions

Initial checks:

- `permissions.command_mutation_unclassified`
- `permissions.command_mutation_without_permission`
- `permissions.provider_runtime_default_chain`
- `permissions.provider_runtime_boundaries`
- `permissions.local_operator_explicit`
- `permissions.runtime_bootstrap_scope`

The command registry SHOULD expose explicit metadata for:

- whether the command mutates state;
- risk level;
- required permission scope;
- guard function or service path;
- whether direct local CLI execution is allowed without agent context.

Until explicit metadata exists, verb/path heuristics MAY mark commands as
unclassified `warn` findings. They MUST NOT be reported as unsafe `error`
solely from a name heuristic.

Retired permission storage drift belongs to migration tooling, not the default
doctor permissions domain. The default doctor MUST validate the active
Permission Provider Runtime chain, boundary invariants, explicit
operator-control semantics, and runtime bootstrap scope.

## Costs

Initial checks:

- `costs.pricing_unpriced_usage`
- `costs.pricing_catalog_stale`
- `costs.event_incomplete_usage`
- `costs.event_pricing_inconsistent`

Usage with tokens and no price SHOULD be at least `warn`. It SHOULD become
`error` in release/deploy contexts if cost accounting is a required gate.

Provider/model rows with zero tokens MAY be `info` unless they indicate missing
usage accounting.

## Runtime

Initial checks:

- `runtime.daemon_offline`
- `runtime.bundle_mismatch`
- `runtime.branch_drift`
- `runtime.dirty_worktree`
- `runtime.schema_missing`
- `runtime.migration_unverifiable`

Runtime checks MUST normalize process names and known aliases before reporting
failures. For example, renamed Omni process names MUST not be reported as
missing when the replacement process is healthy.

Dirty worktree SHOULD be `info` in development contexts and `warn` or `error`
only in release/deploy contexts.

## Sessions And Routes

Initial checks:

- `routes.agent_missing`
- `routes.instance_missing`
- `routes.duplicate_effective_route`
- `sessions.agent_missing`
- `sessions.aborted_last_run`
- `chats.eligible_without_route`

Routes pointing to missing agents or instances SHOULD be `error` because they
can drop or misroute inbound messages.

Duplicate routes MUST compare effective routing keys, not only raw row ids.

Chats without routes SHOULD be `warn` only when the chat is eligible for active
routing. Passive, archived, or intentionally unowned chats MAY be `info`.

## Channels And Omni

Initial checks:

- `channels.instance_disconnected`
- `channels.instance_health_missing`
- `channels.provider_health_unavailable`
- `channels.inbound_actor_unresolved`
- `channels.inbound_contact_unresolved`

Enabled production instances that are disconnected SHOULD be `error`.

Provider health missing SHOULD be `warn` unless a provider is known required
for the active runtime.

Recent inbound messages without resolved actor metadata SHOULD be `error`.
Recent inbound messages without contact or agent metadata SHOULD be `error`
unless the message type is explicitly anonymous/system.

## Evidence Standards

Evidence SHOULD include counts and representative examples.

Examples MUST be bounded. A check that finds thousands of rows SHOULD emit:

- total count;
- first few representative ids;
- relevant entity names;
- read command or table/source name.

Evidence MUST avoid raw secrets and long payloads.

## Extensibility

New domains MAY be added when the finding category is stable enough to act on.

New checks MUST be documented here before becoming a default doctor check.

Experimental checks MAY exist behind `--experimental` or an internal flag, but
they MUST NOT affect default exit codes.
