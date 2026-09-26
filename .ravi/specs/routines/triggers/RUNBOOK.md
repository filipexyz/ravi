---
id: routines/triggers
title: "Trigger Topics And Filters Runbook"
kind: capability
domain: routines
capability: triggers
status: draft
---

# Trigger Topics And Filters Runbook

## Pick A Subject Before Creating A Trigger

1. Look the subject up in the catalog instead of guessing it:

```bash
ravi triggers topics
ravi triggers topics --json
```

2. Prefer a cataloged subject. It comes with a payload schema, common filters, and sometimes a default message template, which lets `triggers add` omit `--message`.
3. A custom subject is allowed, but the CLI warns about it. Confirm that some publisher actually emits it before relying on the trigger.

## Write A Filter

- Values must be quoted strings; event values are coerced to strings before comparison:

```bash
ravi triggers add "PR 42 events" \
  --topic "ravi.watch.github.*" \
  --filter 'data.payload.repository == "owner/repo" && data.payload.number == "42"' \
  --message "PR 42 changed. Review the event."
```

- `triggers add --filter` and `triggers set <id> filter` reject invalid syntax before saving it. The usual cause is an unquoted value (`data.number == 42`, `data.branch == main`).

## Find Triggers That Will Not Fire

1. List triggers and read the `STATE` column. Anything other than `active` is not loaded by the runner:

```bash
ravi triggers list
```

2. For machine-readable output, including the parse error and the warnings with fix commands:

```bash
ravi triggers list --json | jq '{warnings, inactive: [.items[] | select(.runtimeState != "active") | {id, name, executionType, runtimeState, filterError}]}'
```

3. Inspect one trigger. For `invalid_filter`, `show` prints `State reason`, `Filter error`, and the `Fix` command:

```bash
ravi triggers show <id>
```

4. Confirm what the daemon did at boot or on the last refresh:

```bash
ravi daemon logs -t 500 | grep -E "invalid filter|Subscriptions set up"
```

A skipped trigger logs `Skipping trigger with invalid filter (fail-closed); fix or clear the filter to activate it` at ERROR level, and the `Subscriptions set up` line reports `skippedInvalidFilter=<n>`.

## Recover A Trigger With An Invalid Filter

1. Fix the filter (preferred). The CLI validates it before saving and emits `ravi.triggers.refresh`:

```bash
ravi triggers set <id> filter 'data.payload.number == "42"'
```

2. Or clear it. On a `--shell` trigger this makes the command run for every event on the topic, so check that the topic is narrow enough first:

```bash
ravi triggers set <id> filter -
```

3. Or take the trigger out of service:

```bash
ravi triggers disable <id>
ravi triggers rm <id> --execute
```

4. Verify: `ravi triggers show <id>` reports `State: active`, and the next `Subscriptions set up` log line no longer counts it in `skippedInvalidFilter`. No daemon restart is needed.

If the CLI reports `active` but the daemon still skips the trigger, the CLI is probably pointing at a different state directory than the daemon. Re-run with the repo wrapper (`./bin/ravi`) that targets the live runtime.

## `gh-follow` Triggers

- Triggers named `gh-follow:<owner>/<repo>#<number>` are generated. Do not hand-edit their filters.
- The follow maintenance sweep rewrites invalid filters on triggers for open PRs to the canonical form and emits one refresh. It runs about 5 seconds after the daemon starts, then every `RAVI_GH_FOLLOW_MAINTENANCE_MS` (default 60000, minimum 10000). A repair shows up in the `gh follow maintenance` log line as `triggersRepaired`.
- If maintenance is off (`RAVI_GH_FOLLOW_ENABLED=0`), nothing repairs these triggers. Fix them with `ravi triggers set <id> filter ...`, using the same shape `ghFollowFilter` produces.

## Task Automations

- Task automations share the filter primitive. When an automation filter is invalid, the run is recorded as `skipped` with `Filter is invalid: <error>`, and the daemon logs `Task automation filter is invalid; skipping (fail-closed)`:

```bash
ravi tasks automations show <id>
```

- `tasks automations add --filter` does not validate the expression yet, and there is no `set` command. To fix a filter, delete the automation and add it again with a valid `--filter`, then check the next run in `show`.

## Avoid

- Do not use `ravi triggers test <id> --execute` to check a filter. It fires the trigger directly with synthetic data, bypassing both the filter and the activation state, and a `--shell` trigger really runs its command.
- Do not re-enable an `invalid_filter` trigger and expect it to fire; `enable` warns that it still will not.
- Do not write filters directly into the database; that skips validation.
- Do not clear the filter on a wildcard-topic `--shell` trigger just to make it fire again.
