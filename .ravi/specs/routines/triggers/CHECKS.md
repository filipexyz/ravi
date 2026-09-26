---
id: routines/triggers
title: "Trigger Topics And Filters Checks"
kind: capability
domain: routines
capability: triggers
status: draft
---

# Trigger Topics And Filters Checks

## Spec Checks

```bash
ravi specs get routines/triggers --mode full --json
ravi specs get routines/triggers --mode checks --json
ravi specs sync --json
```

## Regression Tests

```bash
bun test src/triggers/
bun test src/cli/commands/triggers.test.ts
bun test src/hooks/gh-watch.test.ts src/hooks/gh-follow-sweep.test.ts
bun test src/tasks/automations.test.ts
```

Verify:

- `src/triggers/__tests__/runner-filter.test.ts` passes: a topic whose only trigger has an invalid filter MUST NOT be subscribed.
- On a topic shared by valid and invalid agent and shell triggers, only the valid triggers MUST fire, and only for the matching event.
- Fixing an invalid filter followed by `ravi.triggers.refresh` MUST activate the trigger; a filter that becomes invalid followed by a refresh MUST drop it.
- `src/triggers/__tests__/activation.test.ts` passes: `resolveTriggerActivation()` returns `invalid_filter` even for disabled triggers, and `blocked_topic` for internal `ravi.session.*` topics.
- `src/triggers/__tests__/filter.test.ts` passes: a compiled invalid filter returns `false` for every event.

## Fail-Closed Runtime

A persisted enabled trigger whose filter does not compile (for example `data.branch == main`):

- MUST NOT get a subscription entry.
- MUST NOT send an agent prompt.
- MUST NOT run its shell command.
- MUST produce an ERROR log `Skipping trigger with invalid filter (fail-closed)` with the trigger id, topic, execution type, and parse error.
- MUST be counted in `skippedInvalidFilter` on the `Subscriptions set up` log line.

A trigger with a valid filter, or with no filter, MUST behave exactly as before.

## Operator Visibility

- `ravi triggers list --json` MUST report the invalid trigger with `runtimeState: "invalid_filter"`, `filterStatus: "invalid"`, and a `filterError`, plus a top-level `warnings[]` entry containing the fix command.
- `ravi triggers list` text output MUST show `invalid_filter` in the `STATE` column.
- `ravi triggers list` MUST NOT print warnings when every filter is valid.
- `ravi triggers show <id>` MUST print `State: invalid_filter`, the parse error, and the fix command.
- `ravi triggers enable <id>` on an invalid-filter trigger MUST succeed and MUST warn that the trigger will not fire.
- The CLI verdict MUST come from `resolveTriggerActivation()`, the same function the runner uses.

## Recovery

- `ravi triggers set <id> filter '<valid expression>'` MUST persist the filter, report `runtimeState: "active"`, and emit `ravi.triggers.refresh`.
- `ravi triggers set <id> filter -` MUST persist a null filter, so `ravi triggers show <id>` no longer lists a filter and reports `State: active`.
- `ravi triggers set <id> filter 'data.ok == true'` MUST fail, because values must be quoted.

## Generated Filters

- `ghFollowFilter(repo, number)` MUST return a filter that passes `validateFilter` and matches only that repo and PR number, through both `payload.number` and `payload.pull_request.number`.
- The `gh-follow` maintenance sweep MUST rewrite invalid filters on triggers for open PRs, MUST leave canonical filters untouched, and MUST delete triggers whose PR is no longer open instead of repairing them.

## Task Automations

- A task automation with an invalid filter MUST record a `skipped` run whose message starts with `Filter is invalid:`, and MUST NOT create a follow-up task.

## Topic Catalog

- `ravi triggers topics --json` MUST include `schema.fields[]` for built-in trigger-ready subjects.
- `ravi triggers add --topic "custom.external.>"` without `--message` MUST fail, because custom subjects have no catalog template.
- `ravi triggers add --topic "whatsapp.*.reaction"` MUST succeed with a warning pointing at `ravi.inbound.reaction`.
