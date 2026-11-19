---
id: routines/triggers
title: "Trigger Topics And Filters Rationale"
kind: capability
domain: routines
capability: triggers
status: draft
---

# Why Trigger Topics And Filters Work This Way

## Problem

A trigger binds a NATS subject pattern to an agent prompt or a shell command. Two things decide whether it does useful work or causes damage: whether the subject is real, and whether the filter narrows events down to the ones the trigger is meant for.

Agents and operators used to guess subjects by symmetry (for example `whatsapp.*.reaction`) that no Ravi publisher ever emitted. The trigger saved fine and then never fired. The topic catalog exists so that subjects, payload schemas, and default messages come from a durable source instead of inference.

Filters are the deterministic pre-agent gate. On a wildcard topic such as `ravi.watch.github.*`, the filter is the only thing that separates "this PR in this repo" from "every GitHub event the daemon sees". For `--shell` triggers there is no agent in the loop to notice a mismatch: a match runs the command.

## Failure Modes Observed

1. **Invented subjects** — triggers on transport aliases with no publisher look healthy and never fire.
2. **Fail-open filters (admin bug 40fa4044)** — the runner loaded triggers whose persisted filter did not compile, logged `Loaded invalid trigger filter; preserving legacy fail-open behavior`, and subscribed them with no effective filter. A broken filter made the trigger match every event on its topic. In a reproduction against a real NATS server, a shell trigger meant for `filipexyz/ravi` PR 558 ran for another repository and for PR 999.
3. **Silent generator drift** — `ghFollowFilter` wrote the PR number unquoted (`data.payload.number == 558`). The parser has rejected that form since `ae759426`, so every `gh-follow` filter was invalid and only worked because of fail-open. Nothing surfaced it: `triggers list` and `triggers show` looked healthy.
4. **No operator signal** — a single WARN line at boot was the only evidence that a trigger was running unfiltered.
5. **A valid filter that listens to too much** — in about 17 hours of 19/11/2026 the `main` session received 181 `gh-follow` events, which became 5 messages to the user (figures from that day's process review). Two sources are noise by construction. One is the `workflow_run.completed` that repeats a run already reported by `succeeded`, `failed` or `cancelled`: the derivation emits both for every run that has an outcome event. The other is every run of the `PR Description` workflow, which runs on `opened`, `edited`, `synchronize`, `reopened` and `ready_for_review` and is not a merge gate. Nothing was invalid, so the repair above never touched it, and no sweep moved a follow created before the fix.

## Design Choice

- **Fail closed.** A persisted filter that does not compile never activates the trigger: no subscription entry, no agent prompt, no shell command. Losing events from a broken trigger is recoverable; running a shell command on the wrong events may not be.
- **Defense in depth.** A compiled invalid filter evaluates to no-match, so any consumer that forgets the validity check (task automations share the primitive) still fails closed.
- **One activation verdict.** `resolveTriggerActivation()` returns `active`, `disabled`, `invalid_filter`, `blocked_topic`, or `unbound_agent`. The runner and the CLI both call it, so `triggers list` cannot report a trigger as healthy while the daemon skips it. A missing bound agent is `unbound_agent` and must not fall back to a `/tmp/ravi-<id>` session.
- **Derived state, not persisted state.** An invalid-filter trigger stays `enabled` in the database and shows `runtimeState: invalid_filter`. Fixing or clearing the filter is the only step needed to recover, and it takes effect on the next `ravi.triggers.refresh`.
- **Visible by default.** The runner logs an ERROR with the trigger id, name, topic, execution type, filter, and parse error. `list` adds a `STATE` column and a warning with the exact fix command, and `show` and `enable` say the trigger will not fire.
- **Generators must emit valid filters.** Code that writes filters (`gh` PR follow, bug follow, watch triggers) must pass `validateFilter`, and the `gh-follow` maintenance sweep rewrites legacy invalid filters to the canonical form.
- **A changed generator reaches the follows it already wrote.** Changing what `ghFollowFilter` emits changes nothing for a follow that exists: the filter is stored on the trigger, and `ensureGhWatchFollow` runs only when someone touches that PR again. The sweep therefore also rewrites a filter that equals, exactly, one an earlier release generated for that PR. Equality, not "differs from the current one": a hand-written filter on a `gh-follow:` trigger is valid and is not ours to replace. Each generation a release retires is listed beside the generator, so the next change to the filter adds one line instead of leaving old follows behind.
- **Exclude with `!(path == value)`, never `path != value`.** The predicate language answers false to any comparison on a path the event does not carry. `data.payload.name != "PR Description"` is false for a pull request event, which has no `payload.name`, so it would silence every lifecycle and comment event. Negating the equality keeps every event that lacks the field.
- **Drop the repeat only where it is a repeat.** The local derivation emits `workflow_run.completed` for every finished run and adds an outcome event for most conclusions. For `action_required`, `neutral`, `skipped` and `stale` it is the only event, and `action_required` is a run waiting for approval. The filter drops `completed` only for the conclusions that have an outcome event, and reads that set from the derivation's map.
- **Drop it only from the producer that emits the pair.** The Console reports `workflow_run.completed` and no outcome event, so its `completed` is a run's only CI signal whenever the local poller produces nothing: the repo watch deactivated by someone else (`reconcileLocalWatch` never takes it over), `gh` unable to read the repo, the watch not created. An exclusion that ignored `placement` made the follow deaf to every CI result in those cases, which an independent review of the first version of this change found. The exclusion is therefore scoped to `placement == "local"`, and a missing `placement` is heard. The cost is that a run both sources report is heard twice, down from three.

## Rejected Alternatives

- **Keep fail-open with a louder warning.** The trigger would still run shell commands on events it was never meant to see; a log line does not undo that.
- **Auto-disable invalid triggers on load.** The daemon would mutate operator state. After a restart, `enabled: false` is indistinguishable from a deliberate disable, and recovery would take two steps (fix, then enable) that can race with CLI edits.
- **Refuse to start the runner.** One bad row would take down every trigger, including the valid ones.
- **Drop only the clause that does not parse.** That silently changes the meaning of the filter and can widen matching, which is the failure this spec forbids.

## Parent-owned PR follows

PR CI normally finishes after its publishing thread. Choosing the parent at registration removes that lifetime race, including a delayed PR-number lookup. Maintenance also repairs existing follows: a creation guard alone leaves durable stale pointers behind. The saved lifecycle, not the latest observer, identifies the authorized parent and root reply fallback. Close-time retargeting of all triggers would silently change user-owned subscriptions, so the lifecycle refuses those until explicitly handed off.

API publication uses the same rule. Its preflight rejects missing or ambiguous lineage before creating a PR; registration checks again after GitHub I/O. Degrading to the child would recreate the orphan, and manufacturing a lifecycle from a Slack source would guess its owner. Older publication tests expected a fictional child recipient without any lifecycle; they now seed isolated lifecycle state and assert the parent destination. A runner regression publishes through the API boundary, closes and prunes the child both during and after publication, and verifies the next CI event still reaches the parent.
