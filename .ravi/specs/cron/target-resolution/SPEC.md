---
id: cron/target-resolution
title: "Cron Target Resolution"
kind: capability
domain: cron
capability: target-resolution
capabilities:
  - diagnostics
  - listing-enrichment
  - doctor-check
tags:
  - cron
  - diagnostics
  - target-resolution
  - doctor
applies_to:
  - src/cron/target-resolver.ts
  - src/cli/commands/cron.ts
  - src/cli/commands/doctor.ts
  - src/cli/cron-show-output.ts
owners:
  - ravi-dev
status: draft
normative: true
references:
  - cli/listing
  - doctor
---

# Cron Target Resolution

## Intent

Compute the health of each cron job's execution target at inspection time,
without persisting any health state. This makes stale or orphan targets
visible in `ravi cron list`, `ravi cron list --json`, and `ravi doctor`.

## Resolution States

| State                    | Meaning                                                                 |
|--------------------------|-------------------------------------------------------------------------|
| `ok`                     | Agent exists, reply session resolves (or is not needed).                |
| `agent_missing`          | The referenced `agentId` does not resolve to a registered agent.        |
| `reply_session_missing`  | `replySession` is set but does not resolve to a live session.           |
| `derived_key`            | Reply routing falls back to key-derived channel info (legacy/warning).  |
| `unresolved`             | Cannot determine target validity (catch-all).                           |

## Normative Rules

- `ravi cron list` MUST compute target resolution at listing time, read-only.
- `ravi cron list` MUST NOT persist health state, `CronHealth`, or `health_*` fields.
- Human and JSON cron list outputs MUST expose equivalent target-resolution semantics.
- `ravi cron list --json` MUST remain parseable JSON and include typed target fields for every item.
- JSON compatibility MUST preserve existing `items[]` and `jobs[]` surfaces.
- `ravi doctor` MUST add a documented read-only check for enabled cron stale/orphan targets.
- Doctor findings MUST use stable ids:
  - `cron.agent_missing`
  - `cron.reply_session_missing`
  - `cron.routing_derived_key`
  - `cron.routing_unresolved`
- `derived_key` SHOULD be a warning/legacy state, not a silent OK, even if the last run succeeded.
- Shell jobs MUST NOT be marked stale only because they have no agent executor.
- Shell jobs with `onError=notify-session:<session>` SHOULD diagnose that notification target.

## Out of Scope

- No persistent `CronHealth` table or columns.
- No auto-disable, auto-delete, auto-migrate, or repair.
- No preflight behavior added to `agents delete`.
- No changes to cron runner fail-closed semantics.
