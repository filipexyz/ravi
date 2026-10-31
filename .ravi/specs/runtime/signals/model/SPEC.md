---
id: runtime/signals/model
title: "Signals Model"
kind: feature
domain: runtime
capability: signals
feature: model
capabilities:
  - signal-record
  - signal-lifecycle
  - clear-rule
  - signal-scope
tags:
  - runtime
  - signals
  - data-model
  - lifecycle
applies_to:
  - src/signals/types.ts
  - src/signals/signal-db.ts
  - src/signals/service.ts
  - src/signals/probes.ts
  - src/cli/commands/signals.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Signals Model

## Intent

Define the durable shape of a signal, its state machine, its close rule, and its scope.

This feature exists so a signal is a first-class runtime object with predictable identity, closure, and accounting, instead of a prompt string that nobody can query later.

## Record

A signal is stored locally in the Ravi state directory (same SQLite family as the task runtime). The canonical persisted fields are:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | text | yes | `sig_<ulid>`, immutable |
| `key` | text | yes | Stable producer identity, unique among non-terminal signals |
| `schema_version` | integer | yes | `1` for this spec |
| `kind` | text | yes | `fact` or `judgment` |
| `producer_type` | text | yes | `code` or `agent` |
| `producer_id` | text | yes | `doctor.disk`, `agent:main`, `cron:<id>`, `session:<key>` |
| `scope_type` | text | yes | `person`, `chat`, `project`, `agent`, or `install` |
| `scope_id` | text | yes | Canonical id; `install` uses the literal `install` |
| `target_sessions` | text JSON | no | Optional explicit target session names |
| `subject_type` | text | no | `task`, `session`, `agent`, `contact`, or `project` |
| `subject_id` | text | no | Canonical id of the entity the signal is about |
| `severity` | text | yes | `ambient`, `piggyback`, `nudge`, `interrupt`, or `page` |
| `title` | text | yes | One redacted line, at most 120 characters |
| `detail` | text | no | Redacted context, at most 500 characters |
| `evidence_json` | text JSON | no | Structured observation: metric, value, threshold, path, link |
| `clear_when_json` | text JSON | yes | Effective close rule; see below |
| `state` | text | yes | `open`, `surfaced`, `acknowledged`, `muted`, `resolved`, `expired` |
| `previous_state` | text | no | State restored on unmute |
| `dedupe_key` | text | no | Producer event idempotency key |
| `cooldown_ms` | integer | yes | Minimum gap between surfaces of any route |
| `renotify_after_ms` | integer | yes | Re-surface gap after acknowledgement while still true |
| `escalate_after_ms` | integer or null | no | Age after which tick may deliver OOB |
| `max_surfaces` | integer | yes | Lifetime surface cap before ignored expiry |
| `ttl_ms` | integer | yes | Hard lifetime after last observation |
| `reopen_after_ms` | integer | yes | Cooldown before the same key may open again after terminal state |
| `muted_until` | integer or null | no | Epoch ms |
| `mute_reason` | text | no | Human-readable |
| `surface_count` | integer | yes | Incremented on every surface |
| `escalation_count` | integer | yes | Incremented on every OOB delivery |
| `opened_at` | integer | yes | Epoch ms |
| `last_seen_at` | integer | yes | Last producer observation |
| `last_eval_at` | integer or null | no | Last clear-rule evaluation |
| `last_eval_error` | text or null | no | Last probe failure, redacted |
| `surfaced_at` | integer or null | no | Last surface |
| `acknowledged_at` | integer or null | no | Last acknowledgement |
| `acknowledged_by` | text or null | no | `agent:<id>`, `session:<key>`, or `operator:<id>` |
| `closed_at` | integer or null | no | Terminal timestamp |
| `close_reason` | text or null | no | `probe`, `producer`, `operator`, `decay`, `ttl`, `ignored`, `muted`, `superseded`, `subject_terminal` |
| `version` | integer | yes | Optimistic concurrency |
| `created_at`, `updated_at` | integer | yes | Epoch ms |

Companion tables:

- `signal_events`: append-only audit (`raised`, `updated`, `surfaced`, `acknowledged`, `escalated`, `resolved`, `expired`, `muted`, `eval_failed`).
- `signal_surfaces`: one row per surface (`signal_id`, `route`, `session_name`, `turn_id`, `channel`, `budget_day`, `created_at`); this is the shared delivery ledger.

## Identity and Dedupe

- `key` is chosen by the producer and MUST describe the condition, not the occurrence: `host.disk.free`, `task.stalled.task-123`, `inbound.vip.unanswered.contact-42`.
- A producer MUST NOT put timestamps, random ids, or message ids in `key` unless that occurrence is genuinely a different condition.
- `dedupe_key` is for idempotent retries of the same producer event. It is unique within `dedupe_window_ms` (default 24h) and does not replace `key`.
- `raise` is upsert-by-key:
  - no non-terminal signal with the key -> create `open`;
  - existing non-terminal signal -> update title/detail/evidence/severity within the producer ceiling, refresh `last_seen_at`, bump `version`, and keep state;
  - existing terminal signal within `reopen_after_ms` -> no-op with `reason=reopen_suppressed`;
  - existing terminal signal after `reopen_after_ms` -> new signal, same key, new id.
- Updating an acknowledged signal MUST NOT silently reset it to `open`; it stays acknowledged and re-surfaces only after `renotify_after_ms`.

## State Machine

```text
                 raise
                   |
                   v
                 open ------------------------------+
                   | render / tick escalate        |
                   v                               |
                surfaced -- ack --> acknowledged    |
                   |                    |           |
                   | clear              | clear     |
                   v                    v           |
                resolved             resolved       |
                   |                                |
                   +---- ttl / decay / ignored -----> expired

 any non-terminal -- mute --> muted -- unmute/expiry --> previous_state
 any non-terminal -- operator close --> resolved
```

Allowed transitions and side effects:

| From | Event | To | Side effect |
| --- | --- | --- | --- |
| `open` | render includes item | `surfaced` | `surfaced_at`, `surface_count++`, `signal_surfaces` row |
| `open` | tick OOB | `surfaced` | same, route `oob` |
| `open` | ack | `acknowledged` | actor and time recorded; no surface |
| `open` | clear rule true | `resolved` | `closed_at`, `close_reason=probe|producer|operator` |
| `open` | ttl | `expired` | `close_reason=ttl` |
| `surfaced` | ack | `acknowledged` | `acknowledged_at`, `acknowledged_by` |
| `surfaced` | cooldown elapsed and still eligible | `surfaced` | new surface, `surface_count++` |
| `surfaced` | clear rule true | `resolved` | as above |
| `surfaced` | ttl | `expired` | as above |
| `surfaced` | `surface_count >= max_surfaces` and still true | `expired` | `close_reason=ignored` |
| `acknowledged` | `now - acknowledged_at >= renotify_after_ms` and still true | `surfaced` | new surface, `surface_count++` |
| `acknowledged` | clear rule true | `resolved` | as above |
| `acknowledged` | decay / ttl | `expired` | `close_reason=decay|ttl` |
| any non-terminal | mute | `muted` | `previous_state`, `muted_until` |
| `muted` | mute expiry or unmute | `previous_state` | evaluate clear rule first; if true -> `resolved` |
| `muted` | clear rule true | `resolved` | `close_reason=probe|producer|operator` |
| any non-terminal | operator resolve | `resolved` | `close_reason=operator`, reason required |

Rules:

- `ack` on a terminal signal MUST be a no-op, not an error.
- `ack` is idempotent.
- Acknowledging does not close a fact and does not assert health.
- `resolved` is reserved for a positive close rule or an explicit operator decision. `expired` means "we stopped carrying it", not "it is fixed".
- `muted` still evaluates the clear rule. A muted signal that clears becomes `resolved`.
- `muted` suppresses all surfaces and escalations until `muted_until`.

## Clear Rule (`clear_when`)

`clear_when` is data, not code. The persisted JSON is one of:

```json
{"type":"probe","probe":"host.disk","expr":"free_pct >= 20","recheck_ms":300000,"grace_ms":600000}
```

```json
{"type":"metric","field":"free_pct","op":"gte","value":20,"recheck_ms":300000}
```

```json
{"type":"producer_resolve","ttl_ms":86400000}
```

```json
{"type":"decay","after_ms":259200000}
```

```json
{"type":"manual","owner":"operator"}
```

Grammar for `probe.expr` and metric comparisons:

- one to three clauses;
- each clause is `field op number`;
- `op` is one of `>`, `>=`, `<`, `<=`, `==`, `!=` (JSON form uses `gt`, `gte`, `lt`, `lte`, `eq`, `neq`);
- clauses are joined by `and` or `or`, evaluated left to right;
- no parentheses, function calls, variables, strings, unit parsing, or property access;
- unknown fields or operators MUST fail validation at raise time.

`grace_ms` requires the clear condition to hold across that window (two consecutive probe observations by default) before resolving. It exists to prevent flapping.

Close-rule selection:

- `fact` MUST use `probe`, `metric`, or `producer_resolve`.
- `judgment` MUST use `decay` or `manual`.
- `manual` is allowed only when the scope owner is explicit and the signal is `ambient` or `piggyback`.
- A `producer_resolve` fact MUST also carry `ttl_ms`; if the producer disappears, TTL expires it.

## Terminal Subject Guard

A signal MUST NOT outlive the terminal state of the entity it is about.

When a signal declares `subject_type` and `subject_id`, the evaluator MUST check the subject before raising and before every surface:

| Subject | Terminal when |
| --- | --- |
| `task` | `archived_at` is set, or status is `done`, `failed`, or `archived` |
| `session` | deleted, or an ephemeral session that has ended |
| `agent` | deleted |
| `contact` | deleted or merged away |
| `project` | archived or deleted |

Rules:

- `raise` over a terminal subject MUST be rejected with `ENTITY_TERMINAL` and write nothing.
- An existing non-terminal signal whose subject becomes terminal MUST resolve on the next evaluation with `close_reason=subject_terminal`, before any surface or escalation.
- The guard overrides `decay`, `manual`, and `producer_resolve`. A producer that forgets to resolve cannot keep a signal alive over an archived task.
- The guard applies at render and at tick. A signal resolved by the guard MUST NOT surface, page, or consume budget.
- `archived_at` is terminal even when `status=in_progress`. Archiving is an explicit operator decision and MUST NOT be undone by a stale status field.
- A task whose session is ephemeral and has ended MUST be treated as terminal for signal purposes unless the task was explicitly re-dispatched.
- Re-raising after an unarchive creates a new signal; the old one stays `resolved`.

## Probes

A probe is a registered, read-only function with:

- stable `id` (for example `host.disk`);
- typed fields (for example `free_pct`, `free_bytes`, `total_bytes`, `path`);
- hard timeout (default 1s, maximum 5s);
- last-value cache with timestamp;
- no writes, no network, no shell;
- deterministic output for a given state.

The initial registry is deliberately small:

- `host.disk`
- `host.memory`
- `host.load`
- `daemon.health`
- `runtime.stuck_tool`
- `cron.failures`
- `whatsapp.instance`
- `credentials.expiry`
- `cost.spike`

A signal MAY use only a registered probe. Adding a probe is a code change with tests; `clear_when` cannot define new behavior.

Evaluation semantics:

- On render, evaluate only when `now - last_eval_at >= recheck_ms` (default 60s) or when there is no cached value.
- On tick, evaluate every due probe.
- Probe timeout or error: set `last_eval_error`, keep the state, render the item as `unknown` if it still needs attention, and NEVER resolve.
- Three consecutive probe failures across ticks SHOULD raise a `signals.probe.failing` fact (ceiling `nudge`) so the operator learns that monitoring is blind. This is a later phase; the spike only logs and traces.

## Scope

Exactly one scope per signal:

| Scope | `scope_id` | Resolves to |
| --- | --- | --- |
| `install` | `install` | The configured install session (`signals.install_session`, default the agent main session) |
| `agent` | agent id | That agent's main session |
| `chat` | canonical chat id | The session currently attached to that chat |
| `person` | contact id | The session bound to that person's direct chat |
| `project` | project id | Sessions whose current goal is active in that project |

`install` means this installation of Ravi: one daemon and its state DB. It is not a
fleet of installations. Rows stored with the legacy scope `fleet` are converted to
`install` when the schema initializes, and a legacy `signals.fleet_session` setting
is copied to `signals.install_session`.

Rules:

- Resolution MUST return explicit session names. A signal MUST NOT be rendered into a session that does not resolve from its scope.
- `install` MUST resolve to one session, not to every session. Broadcasting an install fact to every agent is a flood.
- `target_sessions` MAY override resolution for a single signal. The override MUST be visible in `ravi signals explain`.
- Scope grants read visibility: `ravi signals list` returns signals resolvable from the current session plus signals the caller owns. `--all` requires operator capability.
- Cross-scope escalation is forbidden. A `project` signal cannot page the install session unless a separate `install` signal exists.

## Persistence and Retention

- Signals live in the local Ravi state directory in SQLite with WAL, alongside the task runtime.
- Terminal signals are retained for 30 days for audit, then pruned.
- Surface rows are retained for 30 days and drive the daily budget queries.
- The store MUST survive daemon restart without losing open, acknowledged, or muted state.
- There is no remote source of truth. A Console copy, if ever added, is a mirror, not authority.

## Acceptance Criteria

- `raise` without an effective clear rule exits with a usage error and writes nothing.
- `raise` a judgment with `severity=interrupt` exits with a usage error and writes nothing.
- `raise` the same key twice returns the same id, increments `version`, updates evidence, and does not create a second non-terminal row.
- `raise` after terminal state inside `reopen_after_ms` is a no-op with `reason=reopen_suppressed`.
- A `probe` clear rule with `grace_ms` requires the predicate to hold across the grace window before resolving.
- Probe timeout leaves the signal non-terminal and records `last_eval_error`.
- Muting suppresses surfaces; unmuting re-evaluates the clear rule first.
- Exceeding `max_surfaces` without ack produces `expired` with `reason=ignored`.
- `ack` on terminal state is a no-op.
- A `person` or `project` signal with no resolvable session stays list-only and is never rendered.
- A signal over an archived task (`archived_at != null`, `status=in_progress`) is rejected at raise with `ENTITY_TERMINAL`.
- An existing signal whose task becomes archived resolves on the next evaluation with `close_reason=subject_terminal` and produces no surface.
- An ended ephemeral session's task produces no new signal and resolves any existing one.
- `ravi signals explain` shows scope resolution, clear rule, last evaluation, and next permitted surface.

## Validation

- `bun test src/signals/model.test.ts`
- `bun test src/signals/probes.test.ts`
- `bun test src/signals/signal-db.test.ts`
- `ravi signals raise ... --json` on a scratch state dir
- `ravi signals show <id> --json`
- `ravi signals explain <id> --json`

## Known Failure Modes

- A key that includes a timestamp turns one condition into thousands of rows and defeats dedupe.
- A `clear_when` predicate that uses an unregistered field silently never clears; validation must reject it.
- A probe without a timeout blocks turn start.
- A `manual` fact is used to avoid writing a real probe; facts then depend on humans and never clear.
- `install` is implemented as a broadcast and floods every agent.
- Terminal rows are pruned before the audit question is answered.
- Optimistic version is ignored, so two producers overwrite each other's evidence.
- Archiving a task does not change `status`, so a status-only producer resurrects a signal over an archived entity.
- An ephemeral session ends, its task stays `in_progress`, and a later observer treats the missing runtime as a stall.
- The subject guard is checked only at raise, so a signal already open when the subject terminates keeps surfacing and paging.
