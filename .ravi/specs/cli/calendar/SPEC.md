---
id: cli/calendar
title: Calendar CLI
kind: capability
domain: cli
capability: calendar
tags:
  - cli
  - calendar
  - local-first
  - agents
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
applies_to:
  - src/cli/commands/calendar.ts
  - src/cli/agent-contract.ts
  - src/calendar
owners:
  - ravi-dev
status: active
normative: true
---

# Calendar CLI

## Intent

`ravi calendars` is the offline-first command surface for Ravi's local calendar
and agenda layer.

Agents MUST be able to use the CLI to inspect and mutate local calendar state
without knowing which remote provider, if any, backs the calendar.

The domain follows the agent-first contract defined by `cli`: typed error
envelopes, the 0/1/2/3 exit taxonomy, a write brake on ops with external or
irreversible effect, and compact discovery via `--fields`.

## General Rules

- Every agent-consumed command MUST support `--json`.
- Commands MUST read and write local SQLite state first.
- The public command surface MUST NOT require Console or provider configuration
  for local calendar use.
- Commands MUST enforce calendar authorization through the Permission Provider Runtime when running in agent/runtime context.
- Commands MUST NOT print provider tokens, sync tokens, raw provider payloads,
  private descriptions, or private locations for unauthorized requesters.
- Commands that accept relative times SHOULD normalize output to ISO timestamps
  with timezone context.
- Commands MUST use local ids in output first and provider ids only as
  provenance.
- Event list/search commands MUST require an explicit bounded time range or use
  a documented safe default window. They MUST NOT perform unbounded full-history
  scans by default.

## Agent-First Contract Invariants

1. With `--json`, every failure on a migrated op MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?}}`.
2. Exit codes MUST follow the taxonomy: `0` success · `1` error (not-found /
   payload / permission) · `2` usage error · `3` blocked by policy (write brake).
3. NOT_FOUND codes follow the resource: `CALENDAR_NOT_FOUND`,
   `SOURCE_NOT_FOUND`, `EVENT_NOT_FOUND`, `OUTBOX_NOT_FOUND`. Calendar and
   source envelopes MUST carry up to 3 `suggestions` from cheap local lists
   already scoped to the requester (visible calendars; local sources). Event and
   outbox envelopes omit `suggestions` — there is no cheap candidate list
   without a bounded window — and MUST carry a `suggestedAction` pointing at the
   listing command.
4. `calendars share`, `calendars events cancel`, and `calendars events respond`
   MUST default to dry-run and require `--execute`; the dry-run MUST report
   `dryRun: true` and the `plan`, exit 3, and MUST NOT write anything (no
   membership row, no event mutation, no outbox row). Validation and permission
   checks run BEFORE the brake so a dry-run is an honest preview. Plans MUST be
   metadata-only: share uses `{calendarId, memberType, memberRef, relation,
   expiresAtPresent}`, where `memberRef` is a pseudonymous stable hash; cancel
   uses `{eventId, calendarId, attendeeCount}`, and
   respond uses `{eventId, calendarId, status, attendeeEmailPresent,
   attendeeAgentId}`. Calendar names, event titles/times, subjects, and attendee
   emails MUST NOT appear.
5. `calendars events list`, `calendars list`, `calendars sources list`,
   `calendars outbox list`, and `calendars availability` MUST accept
   `--fields a,b,c` for compact output.
6. When invoked from an agent context (`RAVI_*` envs present), a thrown
   `ContractError` MUST pass through `runCalendarCommand` untouched (never
   re-wrapped into a `CloudAuthError`) so the registry dispatcher preserves its
   exit code.
7. Unbraked writes keep their current immediate-write behavior (declared):
   `sources create`, `sources sync`, `calendars create`, `calendars disable`,
   `events create`, `events update`, `outbox retry`. All of them are local-only
   and reversible today — see the write classification below.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| calendars share | exposes agenda to another subject (external visibility) | dry-run + `--execute` |
| events cancel | irreversible toward attendees once a provider adapter delivers it | dry-run + `--execute` |
| events respond | addressed to the event organizer once delivered | dry-run + `--execute` |
| events create / update | local write + outbox row only; NO invite is dispatched today (no provider sync adapter exists; `local` provider rows are born `acked`, non-local rows stay `pending` with no consumer). If a provider delivery adapter ships, revisit the brake for create/update with attendees. | not braked (declared) |
| sources create / sync | local config; sync is a no-op tick (`adapter_not_started` for non-local) | not braked (declared) |
| calendars create / disable | reversible local projection | not braked (declared) |
| outbox retry | moves a failed row back to pending; nothing consumes it yet | not braked (declared) |

## Official error cases

| case | code | exit |
|---|---|---|
| calendar not found | `CALENDAR_NOT_FOUND` + suggestions | 1 |
| source not found | `SOURCE_NOT_FOUND` + suggestions | 1 |
| event not found | `EVENT_NOT_FOUND` + suggestedAction | 1 |
| outbox row not found | `OUTBOX_NOT_FOUND` + suggestedAction | 1 |
| braked write without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |

## Known gap

- There is NO dedicated `calendar` skill teaching this surface; the spec and
  runbook are the only shipped guidance. When a skill is added it MUST document
  `--execute` on every braked op.

## Commands

### Calendars

```bash
ravi calendars list
ravi calendars create --name "Luis" --timezone America/Sao_Paulo
ravi calendars show <calendar>
ravi calendars share <calendar> --with <subject> --relation reader --execute
ravi calendars disable <calendar>
```

`calendars share` is write-braked: without `--execute` it prints the plan and
exits 3 without granting anything.

Listing calendars in agent/runtime context MUST return only calendars visible to
the requester.

When `calendars create` runs without an explicit `--owner`, it MUST default to
the active contact actor when one is resolved in runtime context. If no contact
actor is available, it MAY default to the executor agent, then to the local
system owner for direct operator use.

The CLI MUST auto-create or reuse the implicit local source/account needed for
offline calendars. Provider/source management is internal until cloud sync is
introduced.

### Events

```bash
ravi calendars events list --from <time> --to <time>
ravi calendars events read <event>
ravi calendars events create --calendar <calendar> --title <title> --start <time> --end <time>
ravi calendars events update <event>
ravi calendars events cancel <event> --execute
ravi calendars events respond <event> --status accepted --execute
```

`events cancel` and `events respond` are write-braked: without `--execute` they
print the plan and exit 3 without mutating the event or enqueueing outbox rows.

`events list` with no explicit calendar MUST scope to the requester's visible
calendars. It MUST NOT list all local calendars in agent/runtime context.

`events list` MUST require `--from` and `--to` or apply a documented safe
default window. Unbounded recurrence expansion or full-history scans MUST require
explicit diagnostic flags.

`events create`, `events update`, `events cancel`, and `events respond` MUST
create local state or local outbox state before any provider request.

### Availability

```bash
ravi calendars availability --from <time> --to <time>
ravi calendars availability --contact <contact> --from <time> --to <time>
ravi calendars availability --agent <agent> --from <time> --to <time>
```

Availability commands MAY expose free/busy facts when `calendar:free-busy` is
granted. They MUST NOT expose private event details unless `calendar:read` is
also granted.

### Internal Outbox

Calendar writes MAY record local outbox rows for future sync/retry semantics,
but the outbox MUST NOT be exposed as a normal agent/user command in the
offline-only surface.

## Output Shape

JSON output SHOULD include:

- local ids first;
- `calendarId`;
- `accountId`;
- event time range with timezone;
- safe title/description fields based on permission;
- attendee identity ids when authorized;
- provider provenance only when authorized and useful for diagnostics;
- sanitized error codes.

## Acceptance Criteria

- Agents can list and read their authorized calendars through `--json`.
- Agents can create local-only events through the CLI.
- Agents can update/cancel/respond through local outbox semantics; cancel and
  respond require `--execute` (exit 3 dry-run otherwise).
- Availability can return free/busy without leaking private details.
- CLI failures are sanitized and machine-readable; not-found failures use the
  per-resource `*_NOT_FOUND` envelope codes with exit 1.
- `ravi calendar` MAY remain a compatibility alias, but docs, prompts,
  runbooks, and new agent behavior MUST prefer `ravi calendars`.
- Public registry/OpenAPI/SDK surfaces MUST expose only the offline calendar
  commands, not provider sources or outbox diagnostics.
