---
id: runtime/signals/producers
title: "Signals Producers"
kind: feature
domain: runtime
capability: signals
feature: producers
capabilities:
  - signal-producers
  - fact-producers
  - judgment-producers
tags:
  - runtime
  - signals
  - producers
  - doctor
  - tasks
  - agents
applies_to:
  - src/signals/service.ts
  - src/signals/probes.ts
  - src/cli/commands/signals.ts
  - src/cli/commands/doctor.ts
  - src/daemon.ts
  - src/runtime
  - src/tasks
  - src/cron
  - src/channels
owners:
  - ravi-dev
status: active
normative: true
---

# Signals Producers

## Intent

Define who may raise a signal, with which authority, and how code and agents use the same durable surface without pretending to have the same truth.

There is exactly one write contract (`ravi signals raise`) and two producer species (`fact`, `judgment`). The difference is enforced, not documented only.

## Producer Classes

Producer type (`code` or `agent`) is the first cap. Producer class narrows it further:

| Producer class | Examples | Max severity |
| --- | --- | --- |
| `code` | daemon watchdog, doctor probe, channel runner | `page` |
| `agent` | normal agent raising a judgment | `piggyback` |
| `observer` | observation-plane observer raising a judgment | `piggyback` |
| `task-observer` | built-in task observer | `nudge` |
| `operator-assistant` | agent reporting on goals/projects/decisions | `piggyback` |

The effective cap is `min(kind_cap, producer_class_cap, declared_cap)`. A `task-observer` may reach `nudge` only with a fact it can prove; every judgment it raises is `piggyback`.

A producer MUST NOT choose a more alarming class to gain delivery authority. The class is assigned by the runtime from the producer identity, not by a CLI flag alone.

## Task Observer Contract

The task observer is the canonical example of a producer that sees a symptom and is tempted to over-classify it.

Before raising anything about a task, the producer MUST read runtime state:

- `task.status` (from the task runtime);
- `task.archived_at` (archiving does NOT change status);
- `session.kind` (`persistent` or `ephemeral`) and `session.ended`;
- `turn_active` (whether the task's session is inside an active provider turn);
- `pending_count` (whether the session has queued prompts);
- `last_progress_at` (from the task runtime, not from chat text);
- `last_turn_at` and `turn_outcome` (completed, failed, interrupted).

Classification matrix:

| Task state | Runtime state | Signal | Kind | Effective severity |
| --- | --- | --- | --- | --- |
| any | `archived_at != null` | none; resolve any open task signal | - | - |
| any | ephemeral session ended and task not re-dispatched | none; resolve any open task signal | - | - |
| `in_progress` | `turn_active=true` and no progress for > `stall_after` | `task.stalled.<id>` | judgment | `piggyback` |
| `in_progress` | `pending_count>0` | no stall signal; wait for the queued turn | - | - |
| `in_progress` | `turn_active=false` and `pending_count=0` for > `orphan_after` | `task.orphaned.<id>` | fact | `piggyback` (low, once) |
| `blocked` | any non-terminal task | `task.blocked.<id>` | judgment | `piggyback` |
| terminal | any | no signal; resolve any open task signal | - | - |

The producer MUST NOT infer `stall` from "no chat activity", "no task comment", or "no progress field change" alone. Those are compatible with a normal turn that simply did not close the task.

A task-derived signal MUST ALSO set `subject_type=task` and `subject_id=<task-id>`. The runtime terminal-subject guard rejects raises and resolves existing signals when the task is archived or terminal. Producer checks are the first line of defense; the guard is the one that cannot be forgotten.

`task.stalled` evidence MUST include `turn_active=true` and `last_progress_at`. `task.orphaned` evidence MUST include `turn_active=false`, `pending_count=0`, and `last_turn_at`.

A task observer MUST resolve `task.stalled` when the turn ends without progress or when progress is reported. It MUST resolve `task.orphaned` when the task reaches a terminal state. Neither may rely on decay alone if the underlying state is observable.

`task.checkpoint.missed` follows the same rules as `task.stalled`: it is a judgment about an active task, not a fact about a closed one, and it MUST NOT fire for archived tasks or ended ephemeral sessions.

## Producer Contract

Every producer MUST supply:

- `kind`: `fact` or `judgment`;
- `key`: stable condition identity (see `runtime/signals/model`);
- `scope`: one of `person`, `chat`, `project`, `agent`, `install`;
- `title`: one redacted line;
- an effective clear rule;
- `producer_id` and provenance (`source`).

Every producer SHOULD supply:

- `severity` within its ceiling;
- `detail` and structured `evidence`;
- `cooldown_ms`, `ttl_ms`, `escalate_after_ms`, `max_surfaces`;
- `dedupe_key` when retries are possible.

Producers MUST NOT:

- deliver anything directly;
- write conversational messages through signals;
- raise a signal whose clear rule they cannot evaluate or hand to a registered probe;
- raise a fact whose truth depends on model judgment;
- raise a judgment with `nudge`, `interrupt`, or `page`;
- use a key containing a timestamp, message id, or random value unless each occurrence is genuinely a distinct condition;
- raise over a terminal or archived subject (task archived, session ended, entity deleted);
- raise on every turn, poll, or heartbeat "just in case".

## Facts (Code Producers)

Facts are raised by code. Two patterns are allowed:

### Push

The producer observes a state transition and calls the signals service directly (in-process) or the CLI (external process):

```bash
ravi signals raise daemon.crash_loop \
  --kind fact \
  --scope install \
  --severity page \
  --title "Daemon crashed 4 times in 10 minutes" \
  --detail "Last exit: 137" \
  --evidence '{"restarts":4,"window_minutes":10,"last_exit":137}' \
  --clear-producer-resolve --ttl 30m \
  --cooldown 30m --escalate-after 0 \
  --source daemon.watchdog
```

Push producers MUST also resolve explicitly when the condition ends:

```bash
ravi signals resolve daemon.crash_loop --reason "daemon stable for 30m" --by daemon.watchdog
```

or rely on `producer_resolve` + TTL when they cannot guarantee a resolve call.

### Probe

The producer registers a read-only probe and raises with `clear_when.type=probe`. The evaluator re-reads the world at render/tick:

```bash
ravi signals raise host.disk.free \
  --kind fact \
  --scope install \
  --severity page \
  --title "Disk free below 15%" \
  --detail "/ has 9.2% free" \
  --evidence '{"metric":"free_pct","value":9.2,"threshold":15,"path":"/"}' \
  --clear-probe host.disk \
  --clear-expr "free_pct >= 20" \
  --recheck 5m --grace 10m \
  --cooldown 6h --ttl 24h --escalate-after 0 \
  --source doctor.disk
```

Probe facts are preferred for anything continuously measurable. Push facts are preferred for discrete events (crash, offline, rate limit) where the producer knows the transition.

### Fact catalog

| Key | Probe / push | Clear rule | Ceiling | Default cadence |
| --- | --- | --- | --- | --- |
| `host.disk.free` | probe `host.disk` | `free_pct >= 20` | `page` | 5m recheck, 6h cooldown |
| `host.memory.pressure` | probe `host.memory` | `available_pct >= 15` | `page` | 5m |
| `host.load.high` | probe `host.load` | `load1 <= cores * 1.5` | `interrupt` | 5m |
| `daemon.crash_loop` | push daemon | resolve + ttl 30m | `page` | event |
| `daemon.stuck_turn` | probe `runtime.stuck_tool` | `stuck == false` | `interrupt` | 1m |
| `task.orphaned.<id>` | probe `task.state` | `status not in (in_progress, blocked)` | `piggyback` | 15m, no escalation |
| `credential.expiring` | probe `credentials.expiry` | `days_left > 14` or resolved | `interrupt` | 6h |
| `channel.instance.offline` | probe `whatsapp.instance` | `connected == true` | `page` | 1m |
| `cron.failing` | push cron | resolve + ttl 6h | `interrupt` | event |
| `cost.spike.daily` | probe `cost.spike` | `ratio <= 2` | `nudge` | 1h |
| `provider.rate_limit` | push provider | ttl 30m | `nudge` | event |

The exact probe ids and field names are owned by `src/signals/probes.ts`. A new fact key without a registered probe or an explicit producer is invalid.

## Judgments (Agent Producers)

Judgments are raised by an agent that read context. They use the same CLI with `--kind judgment` and a decay/manual close rule:

```bash
ravi signals raise task.stalled.task-123 \
  --kind judgment \
  --scope agent:main \
  --severity piggyback \
  --title "Task task-123 dispatched 4h without progress" \
  --detail "Last progress at 10:12Z; checkpoint overdue twice." \
  --evidence '{"task":"task-123","last_progress_at":"2026-10-21T10:12:00Z"}' \
  --clear-decay 72h \
  --cooldown 12h \
  --source session:main-t-1792600099406879
```

Rules:

- The agent MUST include the evidence it actually read: task id, session, message ids, timestamps, or a link.
- The agent MUST NOT raise a judgment about something it did not observe in this turn or in a durable record.
- The agent MUST NOT raise more than one judgment per condition per session per day. Re-raising updates the existing key.
- The agent MUST NOT use a judgment to ask the operator to do something. If a message is needed, use the normal reply or `sessions send`.
- A judgment's ceiling is `piggyback`. The CLI MUST reject higher severities even if the text says "critical".
- Judgments decay. If the condition is still true after decay, the agent may raise a new signal after `reopen_after_ms`, with fresh evidence.

### Judgment catalog

| Key | Owner | Scope | Evidence | Default decay |
| --- | --- | --- | --- | --- |
| `task.blocked.<id>` | task agent/observer | `agent:<id>` | task event, blocker reason | 72h |
| `task.stalled.<id>` | task observer | `agent:<id>` | `turn_active=true`, last progress, checkpoint misses | 6h |
| `task.orphaned.<id>` | task runtime/observer | `agent:<id>` | `turn_active=false`, `pending_count=0`, last turn | until task closes |
| `agent.idle.<id>` | supervisor/agent | `agent:<id>` | no active task, last turn | 24h |
| `contact.cooled.<id>` | CRM agent | `person:<id>` | last inbound/outbound, cadence | 7d |
| `commitment.missing_followup.<id>` | CRM agent | `person:<id>` or `chat:<id>` | meeting note, promised date | 72h |
| `inbound.vip.unanswered.<id>` | CRM/operator assistant | `person:<id>` | message id, received at, waiting time | 24h |
| `meeting.no_notes.<id>` | meeting/knowledge agent | `project:<id>` or `chat:<id>` | meeting id, ended at | 48h |
| `goal.off_cadence.<id>` | operator assistant | `person:<operator>` | goal, expected cadence, last movement | 72h |
| `project.no_movement.<id>` | operator assistant | `project:<id>` | last task/commit/decision | 7d |
| `decision.pending.<id>` | operator assistant | `person:<operator>` | decision, asked at, waiting time | 72h |
| `anomaly.week.<id>` | operator assistant | `install` | metric, current vs previous week | 7d |

The operator-facing judgments are still judgments: they inform, they do not interrupt. A pending decision that truly must interrupt is a different product decision and MUST NOT be smuggled through a judgment.

## Operator Actions

The operator can:

- `ack` a signal (stops repeats until renotify);
- `resolve` a signal with a reason (terminal);
- `mute` a signal or a key for a duration;
- list, show, and explain;
- disable signals entirely through `signals.enabled=false`.

An operator action is an explicit override. `resolve` on a fact MUST record `close_reason=operator` and the operator identity. It MUST NOT be inferred from a chat reply.

## CLI Contract

Canonical group: `ravi signals`.

```text
ravi signals raise <key> [options]
ravi signals update <id|key> [options]
ravi signals list [--scope ...] [--state ...] [--json]
ravi signals show <id|key> [--json]
ravi signals ack <id|key> [--note ...] [--by ...]
ravi signals resolve <id|key> --reason ... [--by ...]
ravi signals mute <id|key> --for 12h --reason ... 
ravi signals unmute <id|key>
ravi signals tick [--execute] [--json]
ravi signals explain <id|key> [--json]
ravi signals budget [--json]
```

`raise` options:

```text
--kind fact|judgment                  required
--scope <type>:<id>|install             required
--severity ambient|piggyback|nudge|interrupt|page
--title "<one line>"                  required
--detail "<context>"
--evidence '<json>'
--clear-probe <probe-id> --clear-expr "<expr>" [--recheck 5m] [--grace 10m]
--clear-metric <field> <op> <value> [--recheck 5m]
--clear-producer-resolve --ttl 24h
--clear-decay 72h
--clear-manual
--cooldown 6h
--renotify-after 6h
--escalate-after 30m
--max-surfaces 3
--ttl 24h
--reopen-after 24h
--dedupe-key "..."
--source "<producer or session>"
--target-session <name>
--json
```

Validation and exits:

- missing `--kind`, `--scope`, `--title`, or a clear rule -> exit 2, usage error, nothing written;
- judgment with `nudge|interrupt|page` -> exit 2;
- unregistered probe or unknown field -> exit 2;
- unknown `--scope` -> exit 2;
- an agent runtime context raising a `fact` through the CLI -> exit 2 (agents raise judgments only; code producers call the service);
- `raise` is a local write and needs no `--execute`;
- `ack`, `resolve`, `mute`, `unmute` are local writes and need no `--execute`;
- `tick` defaults to dry-run; `--execute` is required to publish or send.

`raise --json` MUST return the persisted record, whether it was created or updated, and the effective clear rule.

Bootstrap agents MAY receive the safe signal command actions (`read` list/show/explain/budget and `mutate` raise/ack) without receiving the whole command group. Agents may ack judgments only; fact acknowledgement requires an operator. `tick`, `resolve`, `mute`, and `update` remain operator/daemon authority because they can close, silence, or downgrade facts.

## Agent Workflow

When an agent observes a durable condition:

1. Check whether the condition is already represented (`ravi signals list --json`, filtered by key or scope).
2. If yes, update it or leave it alone. Do not create a second key.
3. If no, decide fact or judgment:
   - could a deterministic probe or producer prove or disprove it? -> it is a fact, and code should own it;
   - does it depend on context the agent read? -> judgment.
4. Raise with evidence and a close rule.
5. Ack signals it acts on. Resolve only with evidence or an operator decision.
6. Never page. Never interrupt from a judgment.

An agent MUST NOT raise a signal in these cases:

- the information belongs in the task comment, task status, or CRM fact;
- the condition is a one-off event with no duration (use a trigger);
- the agent is repeating what it just said in the chat;
- the "signal" is really a request for the operator to do something now (reply or `sessions send`);
- the evidence is stale or the agent cannot name where it came from.

## Incident Reference: task-b5569b39 (v5 probe)

At 16:30 the task observer raised `task-b5569b39` ("obs v5 probe") as a high-severity OOB interrupt in the operator's DM.

Timeline (UTC):

- 15:59:33 task created by bootstrap and dispatched on ephemeral session `v5-probe` with instruction "Responda apenas OK. Nao use ferramentas.";
- 15:59:39 the session turn completed in about 6 seconds;
- 16:01:38 the task was archived manually: "probe de validacao tool-first (arquivada)";
- 16:29:52 the observer fired `task.checkpoint.missed` and `task.stalled` and delivered an interrupt to the operator chat.

At raise time the task was already archived with `status=in_progress` (archiving does not change status), and the turn had been over for 30 minutes. The observer filtered only by `status=in_progress` and ignored `archived_at` and the runtime turn state.

Two defects:

1. **Wrong route by class.** The producer was a judgment, so its ceiling was `piggyback`. A `task-observer` class is at most `nudge`. The stored severity was `interrupt`, and the delivery path honored the stored field instead of the class cap.
2. **Structural false positive and resurrection over a terminal entity.** "No activity" is not "stalled" when the turn is not active, and an archived task is not a signal subject at all. The correct outcome was no signal; failing that, `task.orphaned` as a low-severity fact that closes when the task closes.

The spec now requires the runtime-state check before `stall`, a distinct `task.orphaned` fact, the terminal-subject guard (`archived_at != null`), and delivery-time ceiling enforcement. This incident is the canonical anti-noise and anti-resurrection fixture in `runtime/signals/spike`.

## Acceptance Criteria

- `raise --kind judgment --severity interrupt` is rejected with exit 2 and writes nothing.
- `raise` without a clear rule is rejected with exit 2 and writes nothing.
- `raise` with an unregistered probe is rejected with exit 2.
- A code producer can raise, update, resolve, and expire a fact through the CLI.
- A code producer that stops calling `raise` on a `producer_resolve` fact expires at TTL.
- An agent can raise a judgment, ack it, and let it decay.
- Re-raising the same key updates the existing record and bumps version.
- `ravi signals list` returns the same records to CLI and agent callers within scope.
- `resolve` requires a reason and records the actor.
- A producer cannot exceed its ceiling by changing the title or detail text.
- A judgment cannot set `escalate_after_ms`.
- A `task-observer` judgment is delivered as `piggyback` even when the stored row says `interrupt` or `nudge`.
- A task with `turn_active=false` and `pending_count=0` produces `task.orphaned`, not `task.stalled`.
- A task with `turn_active=true` and no progress produces `task.stalled`, with `turn_active` in evidence.
- A task that reaches a terminal state resolves both `task.stalled` and `task.orphaned` on the next evaluation.
- A fact with `severity=piggyback` and `escalate_after_ms` becomes OOB as a fact, not as a judgment.

## Validation

- `bun test src/signals/producers.test.ts`
- `bun test src/signals/ceilings.test.ts`
- `bun test src/cli/commands/signals.test.ts`
- `ravi signals raise ... --json` for each kind
- `ravi signals explain <id> --json`

## Known Failure Modes

- A daemon watchdog raises a fact on every restart and never resolves it, so the signal outlives the incident.
- A producer uses `producer_resolve` but never calls resolve and forgets TTL; the signal lives forever.
- An agent raises a judgment after every conversation turn, creating a diary instead of signals.
- A judgment is used to bypass the fact ceiling ("it's urgent, so I used interrupt"); the CLI must reject it.
- A fact key includes an incident id, so the same disk problem opens a new signal every hour.
- The agent resolves a fact because the operator said "ok"; acknowledgement is not resolution.
- A producer writes customer data into `detail`, and the block renders it outside the scope.
