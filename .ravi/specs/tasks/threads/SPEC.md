---
id: tasks/threads
title: "Channel-independent task threads"
kind: capability
domain: tasks
capability: threads
tags:
  - tasks
  - threads
  - runtime
applies_to:
  - src/tasks
  - src/threads/service.ts
  - src/runtime/prompt-subscription.ts
  - src/runtime/message-types.ts
  - src/runtime/session-dispatcher.ts
  - src/runtime/session-resolver.ts
  - src/cli/commands/tasks.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Channel-independent task threads

## Phase 1 boundary

A task MUST materialize exactly one exclusive canonical `threads` record. No channel, chat,
provider timestamp, notification target or runtime session is required to create it.
Creation does not dispatch work. Existing `threads`, `thread_entries`, `thread_links` and
`thread_handoffs` are reused; no parallel Thread entity is introduced.

`tasks.thread_id` MUST be present, unique, immutable and reference a retained Thread.
New databases enforce NOT NULL/FK/UNIQUE. Additive upgrades enforce the same requirement
with an index, insert/update/delete guards and transactional backfill, avoiding a rebuild
of the tasks table and its existing references.

Task lifecycle changes own the linked Thread status. Generic Thread status commands MUST
refuse task-owned Threads. Task completion MUST check decisions, then atomically persist the
task, assignment, event, Thread state and result entry. Any write failure rolls back all
of these. Repeated completion preserves the original result. Failure is closed with
`task.failed`; it is never represented as successful resolution.

## Creation and assignment

A caller-supplied creation idempotency key is scoped by creator agent/session/actor.
Retry MUST return the original task, Thread and event. Reuse with different input MUST fail.
The receipt compares the original request, before resolving the current profile catalog,
so later catalog changes do not replace the pinned profile on retry.

A new executor session uses `agent:<agent-id>:thread:<thread-id>` and retains the profile's
human-readable session name. Existing session keys MUST be preserved, including when an expired executor is recreated
from its frozen handoff. Assignment decides
the executor. Repeating dispatch to the same active assignee/session MUST reuse its assignment;
it MUST NOT create another execution. Terminal tasks MUST refuse redispatch.

The dispatch stores one frozen envelope plus a Thread handoff. Publication success and
execution admission are separate fields. Retrying publication MUST reuse that envelope.
The prompt consumer MUST validate task, assignment, session key, agent and Thread before
claiming the assignment transactionally and forwarding only the stored envelope. The runtime
MUST bypass debounce, refuse agent fallback and recheck the frozen session key before launch.

The execution claim is durable across duplicate publications and process restarts. An
assignment admits dispatch at most once. An exception after claim is `uncertain`; a process
crash may leave `accepting`, which is equally ineligible for automatic replay. Neither
state proves that execution completed. Changing the assignment in either state MUST fail
until the execution is reconciled; an already admitted assignment also cannot be replaced
while active. This is not universal exactly-once side-effect delivery.
Restart recovery MUST NOT republish admitted or uncertain assignments. Existing runtime
pending-message recovery remains responsible for an already admitted execution.

## Import and deferred work

Backfill imports tasks with explicit `task.import` provenance, preserving task IDs, session
keys, events, assignment IDs and any pending payload bytes. Existing assignments without
an admission receipt remain `legacy`, not falsely marked unexecuted. Migration and restart
MUST NOT synthesize a new execution for those assignments.

Phase 2 remains required before projecting this Thread to Slack and WhatsApp simultaneously:
destination-scoped bindings, per-message inbound correlation, independent delivery receipts,
and import of the old channel lifecycle as provenance. A whole-chat subscription MUST NOT
be used as a binding for one task in a shared WhatsApp DM. External ambiguity MUST be
reconciled as uncertain and MUST NOT redispatch the task.

Phase 1 does not import Slack lifecycle records or pending channel deliveries into canonical
Thread bindings. They retain their existing writer until the explicit phase 2 cutover;
new task Threads do not invoke or write that lifecycle. No automatic production rollout is
part of this change.
