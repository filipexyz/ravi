---
id: cli/calendar
title: Calendar CLI Runbook
kind: runbook
domain: cli
capability: calendar
status: active
normative: false
owners:
  - ravi-dev
---

# Calendar CLI Runbook

## Contract Debug Flow

1. Reproduce the failing call with `--json` and read `error.code` first; the
   code, not the message, is the branch point.
2. Exit `1` + `CALENDAR_NOT_FOUND` / `SOURCE_NOT_FOUND`: read
   `error.suggestions` — real local calendars/sources similar to what was
   asked. Retry with one of them.
3. Exit `1` + `EVENT_NOT_FOUND` / `OUTBOX_NOT_FOUND`: no suggestions are
   emitted; run the listing command from `error.suggestedAction` and retry.
4. Exit `3`: read `error.plan`, confirm the share/cancel/respond is intended,
   then re-run the same command adding `--execute`.
5. If a share/cancel/respond executed without `--execute`, the brake regressed:
   check the op still calls `contractDryRun` before the write, and that
   `runCalendarCommand` still rethrows `ContractError` before its
   `CloudAuthError` wrapping.
6. If a braked op exits 1 with a `PAYLOAD_INVALID` JSON body instead of the
   envelope, `runCalendarCommand` lost the `ContractError` rethrow.

## Braked Writes (dry-run by default)

```bash
ravi calendars share <calendar-id> --with agent:reader --relation reader --json   # exit 3 + plan
ravi calendars share <calendar-id> --with agent:reader --relation reader --json --execute

ravi calendars events cancel <event-id> --json            # exit 3 + plan
ravi calendars events cancel <event-id> --json --execute

ravi calendars events respond <event-id> --status accepted --json            # exit 3 + plan
ravi calendars events respond <event-id> --status accepted --json --execute
```

## Compact Listings

```bash
ravi calendars events list --from now --to +7d --fields id,title,startAt --json
ravi calendars list --fields id,name --json
```

## Create A Local Calendar

```bash
ravi calendars create --name "Luis" --timezone America/Sao_Paulo --json
```

## Create And Read An Event

```bash
ravi calendars events create \
  --calendar <calendar-id> \
  --title "Daily review" \
  --start "2026-06-05T10:00:00-03:00" \
  --end "2026-06-05T10:30:00-03:00" \
  --json

ravi calendars events read <event-id> --json
```

## Check Availability

```bash
ravi calendars availability --from now --to +7d --json
```

## Validation

```bash
bun test src/cli/commands/calendar.test.ts
bun run typecheck
```
