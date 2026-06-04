---
id: runtime/delivery-queue
title: "Runtime Delivery Queue"
kind: capability
domain: runtime
capability: delivery-queue
capabilities:
  - delivery-queue
  - delivery-barriers
  - session-events
  - follow-up-queue
  - immediate-interrupt
tags:
  - runtime
  - sessions
  - events
  - prompts
applies_to:
  - src/delivery-barriers.ts
  - src/omni/session-stream.ts
  - src/runtime/delivery-queue.ts
  - src/runtime/session-dispatcher.ts
  - src/runtime/message-types.ts
  - src/cli/commands/sessions.ts
  - src/session-trace
owners:
  - ravi-dev
status: draft
normative: true
---

# Runtime Delivery Queue

## Intent

The Runtime Delivery Queue decides when a prompt atom may enter an active provider turn.

It exists so external session events, notifications, observer messages, and cross-session messages can be delivered deterministically without cutting an agent mid-response or losing the work it was already doing. Ravi MUST support both a normal follow-up lane and an explicit immediate lane.

## Terms

- **Prompt atom**: the smallest Ravi-owned input unit, as defined by `runtime/session-continuity`.
- **Delivery barrier**: the release rule attached to a prompt atom.
- **Human channel input**: an inbound message authored by a human/contact in an external channel.
- **External session event**: a non-human prompt atom injected into a session by Ravi, CLI, hooks, triggers, cron, observer delivery, daemon resume, tasks, or another session.
- **Follow-up lane**: prompt atoms that wait for the current provider response to finish before delivery. This is represented by `after_response` and exposed to operators as `followup`.
- **Task-completion lane**: prompt atoms that wait until the session is no longer inside an active task. This is represented by `after_task`.
- **Steer lane**: prompt atoms that may enter the active conversation after startup/compaction/tool barriers clear. This is represented by `after_tool` and exposed to operators as `steer`.
- **Immediate lane**: prompt atoms that may interrupt the active turn as soon as Ravi considers it safe. This is represented by `immediate_interrupt` and is a stronger escape hatch than `steer`.

## Barrier Values

Ravi recognizes these delivery barriers:

- `immediate_interrupt`: may preempt an active provider response once startup, compaction, and unsafe tool execution are clear.
- `after_tool`: waits for startup, compaction, and tool execution barriers, then may preempt an active text response. Operator alias: `steer`.
- `after_response`: waits until the current provider response reaches a terminal state. Operator alias: `followup`.
- `after_task`: waits until the current provider response reaches a terminal state and the session has no active task barrier.

The barrier value MUST be stored on the prompt atom and traceable through publish, queue, release, interrupt, and provider handoff events.

## Default Classification

Explicit caller intent wins. If a producer supplies a valid `deliveryBarrier`, the runtime MUST honor that value unless doing so would violate a safety barrier such as startup, compaction, or unsafe tool execution.

When no explicit barrier is provided, Ravi MUST infer the barrier from the source and semantics of the prompt atom:

- Human channel input SHOULD default to `after_tool`, unless the prompt is marked urgent. This preserves the useful behavior where a real user can interrupt a long answer after a safe point.
- Human channel input marked urgent MUST use `immediate_interrupt`.
- `sessions send`, `sessions notify`, hook `send_session_event`, and other generic external session messages MUST default to `after_response`.
- `sessions inform`, `[System] Inform`, artifact notifications, group notifications, daemon resume notices, and observation deliveries MUST default to `after_response`.
- `sessions ask` MUST default to `after_response`.
- `sessions answer` MUST default to `after_response` unless the sender explicitly asks for immediate delivery or the call is part of a synchronous wait/unblock flow that is documented and traced as immediate.
- `sessions execute`, heartbeat prompts, trigger prompts, supervisor prompts, and task checkpoint prompts SHOULD default to `after_task` when their purpose is operational work rather than conversational follow-up.
- Edited message rebase prompts MAY use `immediate_interrupt`, because they intentionally replace the current turn with corrected source state.

No generic external session event may default to `after_tool`. `after_tool` is reserved for human channel input and explicitly requested `steer` behavior.

## Followup, Steer, and Immediate

Every operator-facing producer that can inject an external session event SHOULD expose `followup` and `steer` vocabulary.

`followup` MUST be the default for generic external session events and maps to `deliveryBarrier=after_response`.

`steer` maps to `deliveryBarrier=after_tool`. It is an explicit request to feed the active turn after safe barriers clear.

`immediate` maps to `deliveryBarrier=immediate_interrupt`. It is reserved for urgent correction, cancellation, rebase, or operator intervention that must preempt as soon as safe.

CLI commands MAY expose these as `--barrier followup`, `--barrier steer`, `--steer`, `--barrier immediate_interrupt`, `--barrier p0`, or `--immediate`. The output JSON and session trace MUST show the lane source: explicit caller choice, producer default, or runtime inference.

Immediate delivery is a request, not permission to break safety. The runtime MUST still avoid interrupting startup, compaction, and unsafe tool execution.

## Queue Semantics

Each session owns its pending prompt queue. The queue MUST preserve the original prompt atom payload, source, context, delivery barrier, task barrier metadata, enqueue timestamp, and pending id.

The runtime MAY batch multiple deliverable prompt atoms into one provider turn. Batched prompt atoms MUST keep their original order inside the combined prompt.

The runtime MAY let a higher-priority deliverable prompt atom bypass a blocked lower-priority atom. This is allowed only when the blocked atom's barrier is not currently releasable, such as an `after_task` reminder during an active task. Bypass decisions MUST be traceable.

Within the same barrier lane, delivery SHOULD be FIFO.

`after_response` and `after_task` prompt atoms MUST NOT request provider interruption while the session is generating text. They may wake an idle session after the current turn becomes terminal.

`after_tool` and `immediate_interrupt` prompt atoms MAY request interruption only through the session dispatcher's interrupt path, with trace events that explain the source, barrier, and safety state.

## Producer Contract

Every producer that calls `publishSessionPrompt` MUST choose one of these strategies:

1. Provide an explicit `deliveryBarrier` because the producer owns a clear delivery policy.
2. Provide enough semantic metadata for `inferDeliveryBarrier` to classify correctly.
3. Use a prompt envelope that maps to a documented inferred barrier.

Producers MUST NOT rely on the global fallback for system/external messages. The fallback exists only for legacy safety and should be conservative enough not to interrupt an active response unexpectedly.

## Producer Matrix

Known producers MUST be classified explicitly:

- `src/cli/commands/sessions.ts`
  - `send`: default `after_response`; explicit immediate supported.
  - `send --steer`: maps to `after_tool`.
  - `ask`: default `after_response`.
  - `answer`: default `after_response`, with explicit immediate for unblock cases.
  - `execute`: default `after_task`.
  - `inform`: default `after_response`.
- `src/hooks-runtime/actions.ts`
  - `inject_context`: default `after_response`.
  - `send_session_event`: default `after_response` unless configured otherwise.
- `src/cron/runner.ts`
  - shared-session cron jobs default to `after_response`.
  - cron jobs that are explicitly task/supervisor work MAY use `after_task`.
  - isolated cron sessions still SHOULD carry an explicit barrier for traceability, even when no active turn exists.
- `src/daemon.ts`
  - daemon restart resume notices default to `after_response`.
  - resume notices MUST NOT use the fallback barrier implicitly.
- `src/omni/consumer.ts`
  - human inbound messages may remain `after_tool`.
  - urgent human messages and message edit rebases may be immediate.
- `src/triggers`, `src/heartbeat`, and task checkpoint producers
  - operational prompts should use `after_task` unless they are purely informational follow-ups.
- `src/eval/runner.ts`
  - evaluation prompts SHOULD set an explicit barrier instead of relying on the runtime fallback, even if the eval session is usually idle.
- `src/ephemeral/runner.ts`
  - warning prompts are informational follow-ups and should remain `after_response`.
- `src/tui/hooks/useNats.ts`
  - user-authored TUI messages MAY keep human-input semantics, but the source should remain identifiable as human/operator input.
- Observation-plane deliveries default to `after_response` or `end_of_turn` policies mapped to `after_response`.

The implementation SHOULD keep this matrix close to `inferDeliveryBarrier` tests. A new `publishSessionPrompt` producer without an explicit barrier or recognized metadata SHOULD fail review.

## Trace and Observability

Ravi MUST make queue decisions visible enough to debug "agent stopped responding" and "event interrupted the turn" incidents.

Each published prompt trace SHOULD include:

- session name/key;
- source kind;
- delivery barrier;
- whether the barrier was explicit, defaulted by the producer, or inferred by the runtime;
- prompt atom or pending id when available;
- source message id or event id when available.

Each queued, released, batched, bypassed, or interrupted prompt SHOULD include:

- queue size;
- blocked barrier reason;
- release reason;
- whether an active provider response was interrupted;
- safety state: starting, compacting, tool running, unsafe tool running, generating text, active task id.

## Invariants

- External session events MUST be follow-up by default.
- No external session event may cut an active provider text response unless immediate delivery was explicit or the source is a documented urgent/rebase path.
- Human channel input MAY interrupt after safe barriers because it represents live user intent.
- Provider adapters MUST NOT implement their own delivery queue. Queueing and interruption are runtime responsibilities.
- A queued prompt atom MUST survive provider interruption and daemon restart according to `runtime/session-continuity`.
- A provider turn interrupted by a later prompt MUST still produce exactly one terminal event according to `runtime`.
- Assistant messages MUST be persisted only for non-interrupted terminal turns.
- Queue classification MUST be deterministic for the same payload and explicit options.
- The prompt text should not be parsed ad hoc by producers when structured metadata can classify delivery.

## Acceptance Criteria

- Sending `ravi sessions send <session> "msg"` while the target session is generating text queues the message and does not emit an interrupt request.
- Sending the same command with explicit immediate delivery requests an interrupt when no startup, compaction, or unsafe tool barrier blocks it.
- `sessions inform`, generic `[System] Inform`, hook `send_session_event`, artifact notification, and daemon resume prompt atoms are delivered after the current response.
- `sessions ask` enters the follow-up lane by default.
- `sessions answer` enters the follow-up lane by default, unless the call explicitly opts into immediate or belongs to a traced synchronous unblock flow.
- Operational execute/heartbeat/trigger prompts do not interrupt active task work by default.
- Human channel messages can still interrupt after safe tool barriers.
- Equal-lane queued events are delivered FIFO.
- Trace explains whether a prompt was queued, released, batched, blocked, bypassed, or used to interrupt.
- Tests cover active text generation, tool-running, unsafe tool-running, active task, idle session, daemon restart, and explicit immediate delivery.

## Validation

- `bun test src/runtime/delivery-queue.test.ts`
- `bun test src/runtime/session-dispatcher.test.ts`
- `bun test src/cli/commands/sessions.test.ts`
- `bun test src/session-trace/channel-trace.test.ts`
- `bun run build`
