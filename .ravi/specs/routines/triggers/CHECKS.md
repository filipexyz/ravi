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

## Trigger Owner

```bash
bun test src/triggers/__tests__/ownership.test.ts src/triggers/__tests__/runner-owner.test.ts src/triggers/__tests__/triggers-db.test.ts
bun test src/router/router-db.trigger-session-check.test.ts src/router/sessions.test.ts
bun test src/cli/commands/triggers.test.ts
bun test src/cli/commands/sessions.test.ts
bun test src/runtime/delivery-queue.test.ts src/runtime/runtime-request-builder.trigger-owner.test.ts
bun test --preload ./src/test/isolated-runtime-preload.ts src/runtime/session-dispatcher.test.ts
```

- An owner given on create MUST persist; `unknown` and blank MUST store none; a row with no owner MUST read as `unknown` and MUST NOT act as the operator. The `owner_principal` migration MUST add the column with no owner for existing rows and survive the session CHECK rebuild.
- `dbUpdateTrigger` MUST keep the owner for `cooldownMs`, `shellTimeoutMs` and `enabled: false`, clear it on every other change unless `keepOwnerFor` is the stored owner, and never write an owner.
- The runner MUST publish `_triggerAuthority` for the stored row only while it is the subscribed definition: an edit not reloaded yet, a change by someone else and a deleted row MUST carry `unknown`, and a test fire MUST carry the owner only when `initiator` is the owner.
- An `isolated` trigger a person owns MUST run in `agent:<agent>:trigger:<id>:own`, found by key alone and going by that key as its only name (no other session can be created with it, named or renamed to it, also after the own session is deleted; the own session cannot be renamed; it starts after whatever the journal holds under the name); the snapshot's `ownSessionKey` MUST be that key. A trigger nobody owns MUST keep the plain session, its plain name and `ownSessionKey: null`, as MUST the agent's main session and a named session.
- A trigger that loses its owner MUST fire into the plain session from the next fire on, before the runner reloads it too, and the own session MUST receive nothing more.
- A fire reaching an own session by name, by key or by a value from the event MUST be skipped, the same owner's included; a `main` trigger whose reply session is an own session MUST run in the main session; the plain session of a trigger nobody owns MUST still take other triggers' fires.
- A trigger's session key MUST be recognized only in its three exact forms (not a thread or anything else derived from one), and `getOrCreateSession` MUST refuse to create one for anyone but the trigger runner while returning an existing one to anybody.
- A fire whose snapshot lends authority MUST NOT share a turn with another prompt (pending queue and debounce, either order), MUST NOT take held `!!` text or a deferred bootstrap, MUST NOT be steered, and a folded turn MUST carry no snapshot. A person's trigger fired into a session that is not its own MUST be delivered as before.
- Through the real turn start, a fire that lends authority and has no chat bound MUST record `turnReplyTarget: none` and post to no chat, also after a chat is attached to its session during the turn.
- `ravi triggers add` and `set session` MUST refuse another trigger's own session as a literal target, and `add` MUST default to `main` when run in one. `ravi triggers show` MUST print the name of the session an `isolated` trigger runs in once it exists.
- The intake MUST admit into an own session only its trigger's fires and the runtime's restart notice that names that session, never a failed shell command's notice (`src/runtime/session-dispatcher.test.ts`); hooks MUST NOT run for it (`src/hooks-runtime/runner.test.ts`).
- The audit event of a command run in an own session MUST NOT fire a trigger, and one run in any other session MUST (`src/triggers/__tests__/runner.test.ts`, `src/sdk/gateway/dispatcher.test.ts`).
- A trigger on a wildcard topic MUST NOT fire on `ravi.session.*`, `ravi._reply.*` or `ravi.worker.*` events and MUST fire on any other; a shell trigger's failure notice MUST NOT be sent into an own session, and `--on-error` MUST refuse one (`src/triggers/__tests__/runner-owner.test.ts`, `src/cli/commands/triggers.test.ts`).
- `ravi triggers add|set|enable|show` MUST carry `ownerPrincipal`, `runsAsOperator` and `ownsSession`; `set` by anyone but the owner, and `enable` by anyone but the owner or the operator, MUST clear the owner and warn once, in JSON and in text; the operator enabling someone else's trigger MUST keep its owner; `test` MUST emit `initiator`.
- What a trigger turn may do with its owner is checked in `cli/bases` CHECKS (6b).

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

- A trigger with `agentId` set to an agent that does not exist MUST report `runtimeState: unbound_agent` and MUST NOT create a session cwd of `/tmp/ravi-<agentId>`.
- `ghFollowFilter(repo, number)` MUST return a filter that passes `validateFilter` and matches only that repo and PR number, through both `payload.number` and `payload.pull_request.number`.
- `ghFollowFilter` MUST let each finished CI run of the local derivation through once: the outcome event (`workflow_run.succeeded`, `failed`, `cancelled`) passes and the `workflow_run.completed` the local derivation emits beside it (`placement: "local"`) does not. `workflow_run.completed` MUST still pass for a local run whose conclusion has no outcome event (`action_required`, `neutral`, `skipped`, `stale`, none), where it is the only event. The set of conclusions with an outcome event MUST be read from the derivation's own map, not copied.
- `ghFollowFilter` MUST let a `workflow_run.completed` the Console delivers (`placement: "console"`) through whatever its conclusion, and so an event that carries no `placement`: the Console reports no outcome event, so dropping its `completed` would leave a follow whose local poller produces nothing deaf to every CI result. A repo only the Console reports on MUST yield exactly one heard event per finished run; with both sources the owner hears two.
- `ghFollowFilter` MUST NOT let any run of the `PR Description` workflow through, whatever its outcome or event type, and MUST let a workflow with a similar name through.
- `ghFollowFilter` MUST NOT drop an event that lacks `payload.name`, `payload.conclusion`, `eventType` or `placement` (PR lifecycle, PR comments, Console deliveries). Its exclusions MUST be written as `!(path == value)`: a missing path makes every comparison false, `!=` included.
- The `gh-follow` maintenance sweep MUST rewrite invalid filters and superseded canonical filters (the exact text an earlier release generated for that PR) on triggers for open PRs, MUST leave the current canonical filter and any other valid filter untouched, and MUST delete triggers whose PR is no longer open instead of repairing them. A second pass over repaired triggers MUST change nothing and MUST NOT emit a refresh.
- The same sweep MUST ensure a watch for every repo that still has a follow trigger or a pending follow, MUST NOT ensure a watch for a repo whose last trigger it just removed, and MUST keep the trigger when ensuring its watch fails.

- `ghFollowFilter` MUST NOT let `workflow_run.requested` or `workflow_run.in_progress` through, and MUST let a bot comment through from any producer shape (`payload.author`, `payload.sender.login`). `supersededGhFollowFilters` MUST list the exact filter the previous release wrote (generation 2), pinned as a literal in the test, so maintenance moves existing follows to the current filter.
- A completed run of the local derivation MUST carry `url` and `headSha`, and `gh run list` MUST be asked for both fields.

- [ ] `bun test src/hooks/gh-watch.test.ts src/watch/local-events.test.ts src/watch/connector-contract.test.ts` covers the two items above.

## Prompt And Defaults

- A manual trigger prompt MUST render event data as `key: value` lines (no JSON braces), a watch event MUST show subject, time, payload and links without envelope ids, `{{data}}` MUST put the full JSON in place with no second copy, and the line and value caps MUST hold.
- `defaultTriggerDelivery` MUST return cooldown 0 and debounce 30 s for `ravi.watch.*`, 5 s otherwise; `triggers add` with `--cooldown` MUST add no debounce.
- The conversational-session warning MUST fire only for a default session with a chat, never with `--session`, `--thread` or a shell trigger; `isTriggerDormant` MUST ignore disabled triggers and use a 30-day window.

- [ ] `bun test src/triggers/__tests__/prompt.test.ts src/triggers/__tests__/advice.test.ts src/triggers/__tests__/runner-debounce.test.ts src/cli/commands/triggers.test.ts` covers the three items above.

## Task Automations

- A task automation with an invalid filter MUST record a `skipped` run whose message starts with `Filter is invalid:`, and MUST NOT create a follow-up task.

## Topic Catalog

- `ravi triggers topics --json` MUST include `schema.fields[]` for built-in trigger-ready subjects.
- `ravi triggers add --topic "custom.external.>"` without `--message` MUST fail, because custom subjects have no catalog template.
- `ravi triggers add --topic "whatsapp.*.reaction"` MUST succeed with a warning pointing at `ravi.inbound.reaction`.

- [ ] `bun test src/hooks/gh-watch.test.ts src/hooks/gh-follow-sweep.test.ts` covers parent registration, delayed registration after prune, existing-owner reconciliation, maintenance refresh and missing-parent refusal.
- [ ] `bun test src/triggers/__tests__/runner-named-session.test.ts` confirms actual prompt publication to the repointed parent after close, with correct Slack source and fire count.
- [ ] `bun test src/hooks/gh-pr-publish.test.ts` refuses missing/ambiguous lifecycle or a missing parent before any GitHub request; successful API publication from an open thread targets that thread's child, and from a closed or pruned thread the durable parent.
- [ ] The runner publication regression closes and prunes the child during and after GitHub publication, then verifies CI prompt publication to the parent, root source, incremented fire count and no recreated child.

## Reply Account And Channel

- A `page-comment` follow handed to a parent that last talked on WhatsApp MUST be delivered with the parent's WhatsApp channel, chat and its own account, never the Slack thread's account on that chat.
- A follow whose account was taken from its reply source MUST NOT replace the account of a parent that last talked on the same channel through another account (`ravi-slack` x `ravi-rbbt-slack`), and MUST be used when the parent carries none.
- An account set on its own (`--account`) MUST apply on the channel of its instance, including when the session records the Omni name of the channel (`whatsapp-baileys` for `whatsapp`), and MUST NOT be sent to a destination on another channel: a trigger with `accountId: main` (a WhatsApp instance) replying in a session that last talked on Slack keeps the session's Slack account.
- A source rebuilt from a session key on another channel than the trigger's account, and a frozen reply source used as the destination, MUST keep the account they carry. An account no instance goes by names no channel and MUST still apply.

- [ ] `bun test src/triggers/__tests__/runner-named-session.test.ts src/triggers/triggers.test.ts` covers each case above, in the runner and in `triggerSourceAccount` / `accountChannel` / `sourceFromSessionEntry`.
