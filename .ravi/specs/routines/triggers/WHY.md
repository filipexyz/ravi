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

## Design Choice

- **Fail closed.** A persisted filter that does not compile never activates the trigger: no subscription entry, no agent prompt, no shell command. Losing events from a broken trigger is recoverable; running a shell command on the wrong events may not be.
- **Defense in depth.** A compiled invalid filter evaluates to no-match, so any consumer that forgets the validity check (task automations share the primitive) still fails closed.
- **One activation verdict.** `resolveTriggerActivation()` returns `active`, `disabled`, `invalid_filter`, or `blocked_topic`. The runner and the CLI both call it, so `triggers list` cannot report a trigger as healthy while the daemon skips it.
- **Derived state, not persisted state.** An invalid-filter trigger stays `enabled` in the database and shows `runtimeState: invalid_filter`. Fixing or clearing the filter is the only step needed to recover, and it takes effect on the next `ravi.triggers.refresh`.
- **Visible by default.** The runner logs an ERROR with the trigger id, name, topic, execution type, filter, and parse error. `list` adds a `STATE` column and a warning with the exact fix command, and `show` and `enable` say the trigger will not fire.
- **Generators must emit valid filters.** Code that writes filters (`gh` PR follow, bug follow, watch triggers) must pass `validateFilter`, and the `gh-follow` maintenance sweep rewrites legacy invalid filters to the canonical form.

## Rejected Alternatives

- **Keep fail-open with a louder warning.** The trigger would still run shell commands on events it was never meant to see; a log line does not undo that.
- **Auto-disable invalid triggers on load.** The daemon would mutate operator state. After a restart, `enabled: false` is indistinguishable from a deliberate disable, and recovery would take two steps (fix, then enable) that can race with CLI edits.
- **Refuse to start the runner.** One bad row would take down every trigger, including the valid ones.
- **Drop only the clause that does not parse.** That silently changes the meaning of the filter and can widen matching, which is the failure this spec forbids.
