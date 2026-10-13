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
  - src/meetings/cloud.ts
  - src/meetings/cloud-finalize.ts
  - src/meetings/inbox-handoff.ts
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
under the agent-first contract defined by `cli`. This domain has NO new
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
6. `login`, `finalize`, `fetch`, `leave` and `profiles init` stay unbraked,
   with the rationale declared in code (see classification).
7. `meetings join` sends the Console's cloud bot by default. It runs the local
   Chrome recorder only with `--local`, in its own async worker, or in live
   mode (`--live` or a live profile), because only the local recorder can
   speak in the call. In cloud mode, any local-recorder option (`--out`,
   `--profile-dir`, `--duration`, `--empty-grace`, `--capture`,
   `--initial-prompt*`, `--voice-runtime`, `--agent`, `--context`,
   `--include-session-context`, `--tools`, `--skip-finalize`, `--sync`) MUST
   exit 2 with `LOCAL_RECORDER_OPTION`, and a link that is not Google Meet MUST
   exit 2 with `INVALID_ARGUMENT`. Cloud mode MUST NOT need the
   `meet-record` executable.
8. A cloud join creates the local `meeting.join` artifact first and sends its
   id as `clientRef`; the artifact records `metadata.consoleMeetingId`. When
   the Console's inbox delivers `meetings.recording.ready` or
   `meetings.recording.failed`, the inbox runner starts a detached
   `ravi meetings fetch <id>`, which builds the same `meeting.raw` artifact the
   local recorder produces (or closes the join artifact as failed) and informs
   the session that asked. `fetch` is idempotent per meeting: a lock and a
   record in the meeting's state folder let one run register and notify, a run
   that finds the lock held returns `in_progress`, and `--video` on a later run
   adds the video to the same artifact (`enriched`). A later run that finds
   the recorded artifact with the join artifact still open (an earlier run
   died in between) closes the join and informs the session once.
9. Nothing in this surface names the Console's bot vendor: media is downloaded
   from Console paths with the CLI credentials.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| join | real action, but visible/interruptible (bot is a named participant) and inspectable via pre-existing `--dry-run`; the cloud dry-run prints the Console request and sends nothing | `--dry-run` equivalent (documented, flag kept) |
| leave | only stops a cloud bot that is already recording | not braked (declared) |
| fetch | downloads a finished cloud recording into local artifacts; idempotent | not braked (declared) |
| login | interactive human-driven browser login — the human IS the confirmation | not braked (declared) |
| finalize | local artifact registration from a completed run dir | not braked (declared) |
| profiles init | local reversible config scaffold (tasks `profiles init` precedent) | not braked (declared) |
| reads (list/show/validate/voice-runtimes, cloud list/show) | read-only | not braked |

## Official error cases

| case | code | exit |
|---|---|---|
| meeting profile not found | `MEETING_PROFILE_NOT_FOUND` + suggestions | 1 |
| provider executable missing (local only) | legacy text (install/`RAVI_GOOGLE_MEET_RECORDER_BIN`) | 1 |
| local-recorder option without `--local` | `LOCAL_RECORDER_OPTION` | 2 |
| cloud join on a link that is not Google Meet | `INVALID_ARGUMENT` | 2 |
| Console errors (not logged in, feature off, limits) | the cloud error codes (`AUTH_REQUIRED`, `ORG_ACCESS_DENIED`, `RATE_LIMITED`, ...) | 1, 2 or 3 per `cli` |

## Internal consumers

`src/plugins/internal/ravi-system/skills/meetings/SKILL.md` teaches this
surface: its `## Contrato Do CLI` section documents the `--dry-run`
equivalence on `join` (with the inspect-then-join example), the unbraked ops
with rationale, the not-found envelope and `--fields`.

## Validation

- `bun test src/cli/commands/meetings.test.ts src/meetings/cloud.test.ts`
  green (contract block included). On Windows the recorder stub resolves via
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
