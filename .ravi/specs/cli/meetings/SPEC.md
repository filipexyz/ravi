---
id: cli/meetings
title: "Meetings agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - meetings
tags:
  - cli
  - meetings
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
applies_to:
  - src/cli/commands/meetings.ts
  - src/cli/agent-contract.ts
  - src/plugins/internal/ravi-system/skills/meetings/SKILL.md
owners:
  - ravi-dev
status: active
normative: true
---
# Meetings agent-first CLI contract

## Intent

Make `ravi meetings` (and `meetings profiles`) reliable for agent consumers
under the agent-first contract defined by `cli/crm`. This domain has NO new
`--execute` brake: its riskiest op (`join`) already ships `--dry-run` as the
inspect-before-acting path, and that pre-existing flag is kept as the
documented write-brake equivalent instead of being renamed.

## Invariants

1. With `--json`, every failure on a migrated op MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?}}`.
2. Exit codes MUST follow the taxonomy: `0` success · `1` error (not-found) ·
   `2` usage error · `3` blocked by policy (unused in this domain today; the
   `join --dry-run` equivalent exits 0 with the validated invocation).
3. `meetings profiles show <unknown>` and `meetings join --profile <unknown>`
   MUST exit 1 with `MEETING_PROFILE_NOT_FOUND` and suggestions from the LOCAL
   profile catalog (`listMeetingProfiles`); resolve errors on profiles that DO
   exist keep the legacy text path.
4. `meetings join --dry-run` MUST validate and print the provider invocation
   (args/env) and MUST NOT join, spawn a worker, or create session state. The
   flag MUST NOT be renamed to `--execute`.
5. `meetings profiles list` MUST accept `--fields a,b,c`; `items` and the
   `profiles` alias MUST carry the same projected rows.
6. `login`, `finalize` and `profiles init` stay unbraked, with the rationale
   declared in code (see classification).

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| join | real action, but visible/interruptible (bot is a named participant) and inspectable via pre-existing `--dry-run` | `--dry-run` equivalent (documented, flag kept) |
| login | interactive human-driven browser login — the human IS the confirmation | not braked (declared) |
| finalize | local artifact registration from a completed run dir | not braked (declared) |
| profiles init | local reversible config scaffold (tasks `profiles init` precedent) | not braked (declared) |
| reads (list/show/validate/voice-runtimes) | read-only | not braked |

## Official error cases

| case | code | exit |
|---|---|---|
| meeting profile not found | `MEETING_PROFILE_NOT_FOUND` + suggestions | 1 |
| provider executable missing | legacy text (install/`RAVI_GOOGLE_MEET_RECORDER_BIN`) | 1 |

## Internal consumers

`src/plugins/internal/ravi-system/skills/meetings/SKILL.md` teaches this
surface: its `## Contrato Do CLI` section documents the `--dry-run`
equivalence on `join` (with the inspect-then-join example), the unbraked ops
with rationale, the not-found envelope and `--fields`.

## Validation

- `bun test src/cli/commands/meetings.test.ts` green (contract block
  included). On Windows the recorder stub resolves via
  `RAVI_GOOGLE_MEET_RECORDER_BIN`; the one spawn-dependent test (login) is
  skipped there and runs on POSIX CI.
- Live checks: `meetings profiles show ghost --json` →
  `MEETING_PROFILE_NOT_FOUND`, exit 1; `meetings join --url <meet> --dry-run
  --json` → `mode: "dry-run"`, nothing joined; `meetings profiles list
  --fields id,label --json` narrows items.

## Known Failure Modes

- `resolveMeetingProfile` throws for BOTH unknown ids and broken configs;
  mapping every throw to not-found hides real config errors — the helper
  checks the catalog first and falls back to the legacy text path.
- The recorder stub used by tests is a bash script found via PATH + X_OK; on
  Windows that lookup fails and `fail()` without context kills the whole test
  process via process.exit — the BIN env override keeps resolution
  cross-platform.
