---
id: runtime/signals
title: "Signals"
kind: capability
domain: runtime
capability: signals
capabilities:
  - signals
  - fact-signals
  - judgment-signals
  - signal-lifecycle
  - signal-delivery
  - signal-escalation
tags:
  - runtime
  - signals
  - attention
  - notifications
  - sessions
  - delivery
applies_to:
  - src/signals
  - src/runtime/delivery-queue.ts
  - src/runtime/runtime-request-builder.ts
  - src/delivery-barriers.ts
  - src/cli/commands/signals.ts
  - src/inbox
owners:
  - ravi-dev
status: active
normative: true
---

# Signals

## Intent

Signals are Ravi's memory of the world between turns.

Ravi already has two time modes:

- **reactive**: an operator or a channel speaks, the agent answers;
- **proactive**: cron, trigger, or heartbeat wakes an agent on a schedule.

Signals add the missing third mode: **the world changed, nobody is speaking, and nobody should be woken just to look.** The fact is recorded durably, re-evaluated when a turn actually happens, and delivered by riding along with that turn. Paying for a turn is the exception, not the default.

The feature exists so operational truth does not depend on a periodic agent "checking" and does not disappear when no one is talking.

## Terms

- **Signal**: a durable, scoped condition that remains true until an explicit close rule fires. A signal is not a message and not an event.
- **Fact**: a signal whose origin is code and whose truth is decided by a deterministic probe or the producing code. Facts may escalate up to `page`.
- **Judgment**: a signal whose origin is an agent that read context. Judgments never interrupt; their ceiling is `piggyback`.
- **Clear rule (`clear_when`)**: the declaration of how the signal closes. A record without a clear rule is an event and MUST go through a trigger instead of a signal.
- **Severity**: the signal's delivery policy. The canonical values are `ambient`, `piggyback`, `nudge`, `interrupt`, and `page`. Severity is a delivery class, not a free-form text label.
- **Surface**: one rendering of one signal into one turn, or one out-of-band delivery of that signal.
- **Piggyback**: delivery inside a turn that would happen anyway. Cost: zero extra turns.
- **Out-of-band (OOB)**: delivery that creates or interrupts a turn. Cost: one turn or one interruption.
- **Render-time re-evaluation**: the clear rule is evaluated when the delivery block is being rendered for an actual turn, never when the signal is raised.
- **Escalation**: promotion of an undelivered or unacknowledged signal to OOB delivery after a timeout.

## The Three Primitives

### 1. Fact and judgment are different animals

Fact and judgment share storage and delivery, but they MUST NOT share authority:

| Property | Fact (`kind=fact`) | Judgment (`kind=judgment`) |
| --- | --- | --- |
| Producer | code, daemon, cron, doctor, probe | agent that read context |
| Truth source | deterministic probe or producing code | contextual reading |
| Close | `probe`/`metric`/`producer_resolve`, or operator override | `decay`, or human/agent resolution with reason |
| Severity ceiling | `page` | `piggyback` |
| May interrupt | yes, above `piggyback` | never |
| May page | yes | never |
| Model may close it | no | yes, with reason and evidence |
| Failure if model ignores it | bounded by deterministic OOB escalation | bounded by decay and budget |

The severity ceiling is enforced by producer type, not by the text of the alert. A judgment titled "PRODUCTION DOWN" remains a `piggyback` judgment.

### 2. A signal is a condition with a close rule

Signals have a state machine:

`open -> surfaced -> acknowledged -> resolved | expired | muted`

Every signal MUST declare an effective `clear_when` at raise time. The CLI may default a judgment to `decay:72h`, but the persisted record MUST carry the resolved rule.

If the producer cannot say how the condition stops being true, the correct primitive is an event trigger, not a signal.

### 3. Delivery is a policy, with piggyback as the default

- `ambient`: never enters a prompt. Visible only on demand (`ravi signals list`, `self context`).
- `piggyback`: rendered into the next turn in scope. Zero extra turns. **Default.**
- `nudge`: one OOB follow-up turn when the signal remains unresolved past `escalate_after_ms`. One turn.
- `interrupt`: OOB delivery with `immediate_interrupt` after safe barriers. Facts only.
- `page`: `interrupt` plus a deterministic operator-facing line, repeated until acknowledged or resolved. Facts only.

Every delivery above `piggyback` is an explicit exception and MUST be justified by the producer, the signal's age, and the daily budget.

## Boundary

Signals own:

- the durable condition record and its state machine;
- the clear rule and its evaluation;
- scope and target-session resolution;
- surface accounting, cooldown, dedupe, mute, and budget;
- the prompt block contract and mention policy;
- escalation decisions and their idempotency ledger;
- producer ceilings and audit events.

Signals do not own:

- prompt queueing, interruption safety, or barriers (owned by `runtime/delivery-queue`);
- session delivery mechanics (owned by `runtime/delivery-queue` and the session dispatcher);
- task state (owned by `tasks`);
- inbox item lifecycle (owned by `inbox`);
- event subscriptions and watch polling (owned by `watch` and `triggers`);
- channel outbound formatting (owned by the channel adapter);
- provider state.

Signals MUST reuse existing primitives instead of building a second notifier:

- `src/delivery-barriers.ts` for `after_response` and `immediate_interrupt`;
- `publishSessionPrompt` for OOB delivery;
- `src/inbox` only when a signal needs human triage beyond resolve/mute, never as the signal store;
- `src/runtime/delivery-queue.ts` `beforeTurnStart` as the piggyback seam.

## Invariants

1. A signal MUST have exactly one `scope` and exactly one effective `clear_when`.
2. `raise` MUST NOT deliver anything. Delivery decisions happen only at render time or at tick time.
3. Truth MUST be re-evaluated at render time from the probe or the stored evidence, never trusted from the raise-time text.
4. A fact MUST NOT be resolved by model output alone. Facts close by probe, producing code, or an explicit operator override with reason.
5. An agent runtime context MUST NOT raise a fact. Facts require a code producer; agents raise judgments only.
5. A judgment MUST NOT use `nudge`, `interrupt`, or `page`. The ceiling is enforced at raise time and re-checked at delivery.
6. `piggyback` MUST be the default and MUST NOT create a turn, wake an idle session, or interrupt an active one.
7. OOB delivery MUST go through `publishSessionPrompt` with an explicit delivery barrier. Signals MUST NOT call channel senders directly except for the deterministic `page` line.
8. A signal key MUST be unique among non-terminal signals. Re-raising the same key updates the existing record and MUST NOT duplicate the prompt block.
9. Cooldown and delivery accounting MUST be shared across routes. Per-channel cooldowns are forbidden.
10. The daily surface budget MUST be hard. Success is not volume; it is the rate of surfaced signals that turned into action.
11. A signal that exhausts `max_surfaces` without acknowledgement MUST expire with `reason=ignored` and MUST NOT reopen before `reopen_after_ms`.
12. The prompt block MUST be data. It MUST NOT contain imperative instructions, and the text inside it MUST NOT be treated as an operator instruction.
13. Probe evaluation failures MUST NOT resolve a signal and MUST NOT assert health. They render as `unknown` and leave the record open.
14. Every state transition MUST be persisted with actor, timestamp, and reason.
15. Signals MUST be local-first and survive daemon restart.
16. A signal MUST NOT be used to send a normal conversational message. That is `sessions send`.
17. A signal MUST NOT outlive the terminal state of its subject. An archived task, an ended ephemeral session, and a deleted entity are terminal even when another status field says otherwise.

## Producer Matrix

Known producers and their ceilings:

- `doctor` disk/memory/load checks -> `fact`, ceiling `page` or `interrupt`.
- daemon watchdog (crash loop, stuck turn) -> `fact`, ceiling `page`.
- credential resolver (expiring credential) -> `fact`, ceiling `interrupt`.
- channel runner (instance offline) -> `fact`, ceiling `page`.
- cron runner (repeated failure) -> `fact`, ceiling `interrupt`.
- cost meter (daily spike) -> `fact`, ceiling `nudge`.
- runtime provider (rate limit) -> `fact`, ceiling `nudge`.
- task observer (blocked, stalled) -> `judgment`, effective ceiling `piggyback`; observer class cap `nudge`.
- task runtime (orphaned `in_progress` without an active turn) -> `fact`, low severity `piggyback`, closes when the task closes.
- general agent (idle, cooled contact, meeting without notes) -> `judgment`, ceiling `piggyback`.
- operator assistant (goal off cadence, project stalled, pending decision, weekly anomaly) -> `judgment`, ceiling `piggyback`.

Details live in `runtime/signals/producers`.

## Failure Modes Addressed

| Failure | Control |
| --- | --- |
| Flood: every condition becomes a notification | Hard daily budget, `max_surfaces`, cooldown, selection by severity/age, `ambient` for low value |
| Never closes: operator ignores after three days | Mandatory `clear_when`, TTL/decay, ignored expiry, `reopen_after_ms` |
| Resurrection over a terminal entity | Subject guard at raise and every evaluation; `archived_at` is terminal; ended ephemeral sessions are terminal |
| Hijacks the conversation | Fenced data block, explicit context-only policy, mention rules by severity, no imperatives |
| Lies: stale or swallowed truth | Re-evaluate at render, include observation timestamp, `unknown` on probe failure, deterministic P0 line |
| Double delivery | One `signal_surfaces` ledger, shared cooldown, escalation idempotency key |
| Model swallows the warning | Surface is recorded independently of model output; `page` emits a deterministic line; escalation does not depend on the model |
| Nobody speaks for hours | `tick` escalation for facts; piggyback is the cheap path, not the only path |

## Acceptance Criteria

- A `piggyback` fact raised at 03:00 with no operator turn produces zero turns and is present in the first turn after 14:00, with the probe re-evaluated at that turn.
- The same fact with `severity=page` and no turn for 15 minutes produces exactly one deterministic OOB line within the tick interval.
- A cleared condition is absent from the next turn and is `resolved`, not `expired`.
- A judgment raised with `severity=interrupt` is rejected by the CLI with a usage error and is not stored.
- A signal raised without a clear rule is rejected with a usage error.
- Re-raising the same key twice yields one record and one block item.
- A muted signal produces no block and no OOB.
- A signal acked while still true re-surfaces only after `renotify_after_ms`.
- A signal surfaced `max_surfaces` times without ack becomes `expired` with `reason=ignored`.
- Exhausting the daily budget suppresses further piggyback surfaces; `page` facts are the only documented exception and are audited.
- Probe failure renders `unknown` and never resolves the signal.
- A signal cannot be surfaced in a session outside its scope.
- Trace shows `signalsSurfaced`, `signalsOmitted`, budget used, and escalation decisions.

## Validation

- `bun test src/signals/`
- `bun test src/runtime/delivery-queue.test.ts -t "signal"`
- `bun test src/cli/commands/signals.test.ts`
- `env -u RAVI_CONTEXT_KEY -u RAVI_GATEWAY_URL bun src/cli/index.ts specs get runtime/signals --mode full --json`
- `ravi signals tick --json` (dry-run must not deliver)
- `ravi signals explain <id> --json`

## Known Failure Modes

- A probe is slow or hangs and blocks turn start. Probes MUST have a hard timeout and a cached last value; the render path MUST NOT wait indefinitely.
- A producer raises a new key every time (for example, including a timestamp in the key), defeating dedupe and flooding storage.
- A scope resolver attaches a fleet fact to every session, turning piggyback into a broadcast.
- `clear_when` is treated as a general expression language and becomes an injection or CPU surface. Only registered probes and a tiny comparison grammar are allowed.
- The agent acknowledges a fact to silence it while the condition remains true. Facts re-notify while true, and ack is not resolve.
- Tick stops running, so piggyback works but escalations silently stop. Tick health MUST be observable.
- The daily budget is counted per channel instead of per operator, allowing double delivery across piggyback and OOB.
- Signal detail accumulates raw paths, tokens, or customer data. Redaction happens at write and again at render.
- An archived task keeps `status=in_progress`, so a status-only producer resurrects a signal over a terminal entity and pages the operator.
- An ended ephemeral session is mistaken for a stalled workload because the producer looks at status but not at runtime life.
