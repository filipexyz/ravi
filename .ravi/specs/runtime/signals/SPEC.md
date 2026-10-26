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

Signals add the missing third mode: **the world changed, nobody is speaking, and nobody should be woken just to look.** The fact is recorded durably, re-evaluated by the tick, and delivered by riding along with a turn that happens anyway. Paying for a turn is the exception, not the default.

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
- **`owner`**: the producer identity that raised the signal — a code producer id or an agent id. Ownership is a property of the record, not of the caller's request.
- **`target_session_names`**: the resolved list of session names a signal may surface into. A signal resolves to sessions, never to an agent id.
- **Re-evaluation**: the clear rule is evaluated on tick or on a scheduled recheck, never when the signal is raised and never on the turn path. Rendering reads a bounded cache carrying the stored `observed_at`.
- **Stale observation**: an observation whose freshness cannot be guaranteed because `now - signals_tick_state.last_successful_tick_at > stale_after`. Staleness compares the clock against the last successful tick, not the age of the observation alone. `stale_after` defaults to `2 × tick_interval_ms` (a 5-minute tick gives 10 minutes) and is overridable by `signals.stale_after_ms`; the effective value MUST be persisted explicitly, never left implicit.
- **Tick freshness anchor**: `signals_tick_state.last_successful_tick_at`, a durable single row updated only by a tick that completed without error. A failed, partial, or skipped tick MUST NOT advance it.
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

Authority follows the same rule. Whether a caller may raise a `fact`, request `page`, or `ack` a fact is decided by the resolved caller context (`ToolContext`), never by process environment or by the kind named in the request. A record's `owner` and `kind` are immutable through a re-raise.

### 2. A signal is a condition with a close rule

Signals have a state machine whose transitions are named, not implied. Every transition increments `version` by exactly one and writes an audit row carrying `actor`, `timestamp` and `reason`; there is no untracked write.

| From | To | Trigger | Guard | Effect | Actor |
| --- | --- | --- | --- | --- | --- |
| (none) | `open` | `raise` | key free | row created, `clear_when` persisted, `version 1` | producer |
| any non-terminal | same state | re-raise | same `owner` and same `kind` | eligible fields updated, `version + 1` | producer |
| `open` | `open` | reserve surface | budget + scope + OOB freshness pass | ledger row `pending`, `version + 1`, state unchanged | tick / delivery |
| `open` | `surfaced` | send confirmed | outbox row for the reservation succeeded | ledger row `pending → sent`, `version + 1` | delivery |
| `surfaced` | `surfaced` | reserve + send re-surface | past `renotify_after_ms`; same reserve/confirm split | ledger row `pending → sent`, `version + 1` | tick / delivery |
| `open`, `surfaced` | `acknowledged` | `ack` | caller in scope; not already acknowledged | `acknowledged_at` set once, `version + 1` | operator / agent |
| `acknowledged` | `surfaced` | renotify | past `renotify_after_ms` and still true | ledger row `pending → sent`, `version + 1` | tick |
| any non-terminal | `muted` | `mute` | record is non-terminal | `previous_state` saved, `version + 1` | operator / agent |
| `muted` | `previous_state` | unmute / mute expiry | `previous_state` is non-terminal | restored, `version + 1` | operator / tick |
| any non-terminal | `resolved` | clear rule true, or operator override with reason | facts: probe or producing code, or operator override with reason | terminal, `version + 1` | probe / producer / operator |
| any non-terminal | `expired` | `max_surfaces`, `ttl`, `decay` | — | terminal, `reason` recorded, `version + 1` | tick |
| `resolved`, `expired` | `open` | `raise` on the same key | same `owner` and same `kind` AND past the record's stored `reopen_after_ms` | record reopened, `version + 1` | producer |

`resolved` and `expired` are absorbing. No transition out of them is allowed except the guarded reopen above, which uses the `reopen_after_ms` stored on the record, never a value taken from the new call. `mute` and `ack` on a terminal record MUST be rejected, not coerced. A repeated `ack` in the same state is a no-op: it MUST NOT move `acknowledged_at` or increment `version`.

`decay` counts from `opened_at`, never from the last surface or the last acknowledgement, and is rendered as an absolute deadline (the wall-clock instant at which the record expires), not as a relative "in N hours".

Every signal MUST declare an effective `clear_when` at raise time. At raise, `clear_when` MUST be validated against the probe registry and the allowed field set; an unknown probe id or a disallowed field is a usage error (exit 2) and MUST NOT create a row, so a typo cannot mint a signal that never closes. The CLI may default a judgment to `decay:72h`, but the persisted record MUST carry the resolved rule.

If the producer cannot say how the condition stops being true, the correct primitive is an event trigger, not a signal.

### 3. Delivery is a policy, with piggyback as the default

- `ambient`: never enters a prompt. Visible only on demand (`ravi signals list`, `self context`).
- `piggyback`: rendered into the next turn in scope. Zero extra turns. **Default.**
- `nudge`: one OOB follow-up turn when the signal remains unresolved past `escalate_after_ms`. One turn.
- `interrupt`: OOB delivery with `immediate_interrupt` after safe barriers. Facts only.
- `page`: `interrupt` plus a deterministic operator-facing line, repeated until acknowledged or resolved. Facts only.

Every delivery above `piggyback` is an explicit exception and MUST be justified by the producer, the signal's age, and the daily budget.

Budget is reserved at the same single point where a surface is recorded: inserting the `pending` ledger row and its outbox row happens in one transaction, so two concurrent ticks cannot spend the same unit. Reservation is not consumption: a `pending` row holds the unit to prevent a race but does not consume `surface_count` and does not start a cooldown. Consumption is confirmed only when that row becomes `sent`; a `failed` row contributes zero and releases its reservation, and a terminal failure returns the unit and the OOB slot. Every logical surface, piggyback or OOB, consumes exactly one unit of `surface_count` when sent; OOB additionally reserves one daily OOB slot. The single documented exception is `page` on a fact with a successful, fresh evaluation, and it is recorded as an audited bypass.

OOB eligibility requires a recent, successful evaluation: a signal whose observation is `unknown`, whose observation is `stale`, or whose last evaluation failed MUST NOT escalate. This freshness guard gates OOB only: a `stale` or `unknown` observation still renders in the piggyback block, labeled with that `status`, and is never suppressed from it. `signals.oob_enabled=false` disables escalation only; piggyback rendering continues unchanged. `escalation_count` is derived from the `sent` OOB ledger rows, not stored as an independent counter that can drift.

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
3. Truth MUST be re-evaluated on tick or on a scheduled recheck, never trusted from the raise-time text. Render MUST read a bounded cache; it MUST NOT run a probe, block the turn, or synthesize a timestamp. The rendered observation carries `observation.observed_at <= now`, equal to the stored timestamp of the last evaluation — successful or failed — and, when the last evaluation failed, the real error of that evaluation. A failed evaluation records its own evaluation timestamp and error; rendering MUST preserve that stored timestamp rather than replace it with the render time.
4. A fact MUST NOT be resolved by model output alone. Facts close by probe, producing code, or an explicit operator override with reason.
5. An agent runtime context MUST NOT raise a fact. Facts require a code producer; agents raise judgments only.
6. A judgment MUST NOT use `nudge`, `interrupt`, or `page`. The ceiling is enforced at raise time and re-checked at delivery.
7. Whether a caller may raise a `fact`, request `page`, or `ack` a fact MUST be decided by the resolved caller context (`ToolContext`), never by process environment or by the kind named in the request. `owner` and `kind` are immutable through a re-raise.
8. `piggyback` MUST be the default and MUST NOT create a turn, wake an idle session, or interrupt an active one.
9. OOB delivery MUST go through `publishSessionPrompt` with an explicit delivery barrier. Signals MUST NOT call channel senders directly except for the deterministic `page` line.
10. A signal key MUST be unique among non-terminal signals. Re-raising a key MAY update only a record with the same `owner` and the same `kind`; any cross-owner or cross-kind raise is a usage error and MUST NOT modify the row. A re-raise MUST NOT duplicate the prompt block.
11. Cooldown and delivery accounting MUST be shared across routes. Per-channel cooldowns are forbidden.
12. The daily surface budget MUST be hard, and it is reserved atomically with the `pending` ledger insert and its outbox row. Only a `sent` row consumes `surface_count`; a `pending` row reserves the unit without consuming it or starting a cooldown; a `failed` row contributes zero. OOB counts twice on success (one surface plus one OOB slot), and a released reservation returns both. Success is not volume; it is the rate of surfaced signals that turned into action.
13. A signal that exhausts `max_surfaces` (counted as `sent` ledger rows) without acknowledgement MUST expire with `reason=ignored` and MUST NOT reopen before `reopen_after_ms`.
14. The prompt block MUST be data. It MUST NOT contain imperative instructions, and the text inside it MUST NOT be treated as an operator instruction.
15. Probe evaluation failures MUST NOT resolve a signal and MUST NOT assert health. They render as `unknown`, they leave the record open, and they make the signal ineligible for OOB.
16. Every state transition MUST increment `version` by exactly one and be persisted with `actor`, `timestamp`, and `reason`. There is no untracked write.
17. Signals MUST be local-first and survive daemon restart.
18. A signal MUST NOT be used to send a normal conversational message. That is `sessions send`.
19. A signal MUST NOT outlive the terminal state of its subject. An archived task, an ended ephemeral session, and a deleted entity are terminal even when another status field says otherwise.
20. `list`, `show`, `explain` and `ack` MUST share one scope predicate. A record outside the caller's scope is `NOT_FOUND`, never `FORBIDDEN`, and MUST NOT reveal its existence. A surface resolves to declared session names, never to an agent id.
21. A mutation that depends on a prior read MUST be a compare-and-swap on `version`. If the version moved, the operation MUST re-read and re-validate eligibility before its side effect; a delivery MUST NOT overwrite an operator change made while it was waiting.
22. A failed send MUST NOT consume a surface or start a cooldown. A `pending` row reserves budget to prevent a race but consumes nothing; a `sent` row is the only status that consumes `surface_count` and starts the cooldown; a `failed` row counts as zero and its reservation is released, or the outbox row stays `pending` for retry under the same idempotency key. Retry reuses the same ledger row and key, so it is never counted twice. The outbox is the only retry mechanism.
23. Internal sweeps MUST iterate every open record (keyset pagination). A "newest N" query is not a sweep and MUST NOT be used to decide delivery, expiry, or tick ownership.
24. No surface may render an observation as fresh when `now - last_successful_tick_at > stale_after`. In that case the surface carries `status=stale` with the stored `observed_at` and the signal is ineligible for OOB. This guard gates OOB only: a `stale` observation still renders in the piggyback block with `status=stale`, never suppressed, and `unknown` follows the same rule. `last_successful_tick_at` lives in `signals_tick_state` and advances only on a tick that completed without error; `stale_after` defaults to `2 × tick_interval_ms` (5-minute tick → 10 minutes) and is overridden only by an explicit, persisted `signals.stale_after_ms`.
25. `resolved` and `expired` are absorbing. Leaving them requires a raise that passes the `reopen_after_ms` stored on the record; `mute` and `ack` on a terminal record are rejected, not coerced. A repeated `ack` in the same state is a no-op and leaves `acknowledged_at` unchanged.
26. `decay` counts from `opened_at`, never from the last surface or acknowledgement, and is rendered as an absolute deadline.
27. `clear_when` MUST be validated at raise against the probe registry and the allowed field set. An unknown probe id or a disallowed field is a usage error (exit 2) and MUST NOT create a row.
28. OOB requires a recent, successful evaluation: a signal whose observation is `unknown` or `stale`, or whose last evaluation failed, MUST NOT escalate. `signals.oob_enabled=false` disables escalation only; piggyback still renders. `escalation_count` is derived from the OOB ledger rows, never from an independent counter.
29. For every turn that rendered signals, `signalsSurfaced ∪ signalsSkipped` MUST equal the selected set. `budget.used` MUST equal the number of distinct ledger rows first written in that turn. It records allocation attempts, not presumed successful delivery or the outstanding daily balance; released reservations and delivery outcomes MUST be reported separately. Retrying or updating an existing row is not a new ledger insert.
30. For every signal `S`, the daily `surface_count(S)` equals the number of `sent` rows in its ledger for the day. `pending` rows reserve but add nothing, `failed` rows add nothing, and retries reuse the same row. Daily OOB-slot usage, `escalation_count` and the turn `budget` are derived from the same ledger by status; no second independent counter exists.

## Delivery Transaction

One logical delivery is: select → reserve → send → confirm.

- **Reserve**: in one transaction, insert the `signal_surfaces` row as `pending` and insert the outbox row with an idempotency key. The `pending` row reserves one unit of `surface_count` (and one daily OOB slot for OOB) so two workers cannot spend the same unit, but it consumes nothing and starts no cooldown.
- **Send**: write only from the outbox, never directly. Before sending — and again on every retry — re-validate `version`, scope and eligibility (probe freshness for OOB, mute, terminal state); a stale reservation is released, not sent.
- **Confirm**: on success the same ledger row becomes `sent`; only then does it consume `surface_count`, occupy the OOB slot, and start the cooldown. Reconciliation keys on the idempotency key, so it never creates a second row or counts the same retry twice.
- **Fail**: a retryable failure keeps the ledger row, outbox and reservation `pending`, so no surface is consumed and no cooldown starts; retry reuses the same ledger row and key. A terminal failure or expiry marks the row `failed`, contributes zero, and releases the reservation and OOB slot.
- A crash between reserve and send leaves exactly one of two states: reservation plus `pending` outbox row, or no reservation. It can never leave a fresh cooldown or a consumed surface without a send.
- The outbox is the only retry mechanism. No timer, sweep, or provider redelivery may re-send a surface outside it.
- `signal_surfaces` is the ledger, not a counter: each row carries `status` (`pending`, `sent`, `failed`), and every budget, surface and escalation total is derived from those statuses.
- Tick ownership is acquired by a single conditional write, not read-then-write.

## CLI and Observability Contract

| Exit | Meaning |
| --- | --- |
| 0 | applied |
| 2 | usage error: invalid input, invalid state, cross-owner raise, unknown probe |
| 3 | valid plan, not applied (dry-run without `--execute`) |

- A command with triggered effects MUST be a dry-run and exit 3 without `--execute`.
- A render failure MUST log a warning, preserve the original prompt, and be counted; it MUST NOT silently remove signal blocks.
- Every turn that rendered signals MUST trace `signalsSurfaced`, `signalsSkipped` (with reasons) and `budget`.
- For every turn with a signal block, `signalsSurfaced ∪ signalsSkipped` MUST equal the selected set. `budget.used` MUST equal the distinct ledger rows first written in that turn, regardless of their later outcome. It records allocation attempts; outstanding reservations, releases and successful deliveries MUST be reported separately, and retrying an existing row MUST NOT count as a new insert.
- The generated SDKs are regenerated from the command contract; drift is a build failure.
- The OOB prompt is built from the actual outcome (`sent`, `skipped`, `failed`), never from intent.

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
| Lies: stale or swallowed truth | Bounded cache with the stored observation timestamp, `unknown` on probe failure, `stale` when the tick is late, deterministic P0 line |
| Double delivery | One `signal_surfaces` ledger (with `status`), shared cooldown, atomic budget reservation, escalation idempotency key |
| Model swallows the warning | Surface is recorded independently of model output; `page` emits a deterministic line; escalation does not depend on the model |
| Nobody speaks for hours | `tick` escalation for facts; piggyback is the cheap path, not the only path |

## Acceptance Criteria

- A `piggyback` fact raised at 03:00 with no operator turn produces zero turns and is present in the first turn after 14:00, rendered from the observation stored by the tick; the turn path never runs the probe.
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
- Trace shows `signalsSurfaced`, `signalsSkipped` (with reason, including `stale`), budget used, and escalation decisions.
- A raise of a `fact` key from an agent context, or as `judgment`, exits 2 and leaves the stored row unchanged.
- With `last_successful_tick_at` older than `2 × tick_interval_ms`, the next turn renders `status=stale`, sends no OOB, and shows the original `observed_at`.
- A repeated `ack` in the same state leaves `acknowledged_at` unchanged; `mute` on a resolved record exits non-zero and does not reopen it.
- With the daily budget exhausted, a due `nudge` produces zero prompts; with `signals.oob_enabled=false`, zero prompts and piggyback still renders.
- A raise whose `clear_when` names an unknown probe or a disallowed field exits 2 and writes no row.
- `escalation_count` equals the number of OOB ledger rows for the signal; no separate counter exists.
- `decay` renders as an absolute deadline counted from `opened_at`, unaffected by later surfaces or acks.
- For a turn with a signal block, `signalsSurfaced ∪ signalsSkipped` equals the selected set and `budget.used` equals the ledger rows written that turn.

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
- A second retry path outside the outbox (timer, sweep, or provider redelivery) re-sends a surface and duplicates delivery.
- The daily budget is counted per channel instead of per operator, allowing double delivery across piggyback and OOB.
- Signal detail accumulates raw paths, tokens, or customer data. Redaction happens at write and again at render.
- An archived task keeps `status=in_progress`, so a status-only producer resurrects a signal over a terminal entity and pages the operator.
- An ended ephemeral session is mistaken for a stalled workload because the producer looks at status but not at runtime life.
