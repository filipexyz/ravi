---
id: runtime/observation-plane
title: "Observation Plane"
kind: capability
domain: runtime
capability: observation-plane
capabilities:
  - observation-plane
  - session-observers
  - observer-fanout
  - observer-events
tags:
  - runtime
  - sessions
  - observers
  - tasks
  - events
applies_to:
  - src/runtime
  - src/session-trace
  - src/events
  - src/tasks
owners:
  - ravi-dev
status: draft
normative: true
---

# Observation Plane

## Intent

The Observation Plane is the runtime capability that lets Ravi attach zero or more auxiliary observer sessions to a source session. Observer sessions receive selected canonical events from the source session and can run their own prompts, state, permissions, and tools without contaminating the source session.

The capability exists so monitoring, summarization, quality checks, memory extraction, task reporting, cost controls, and future supervision behavior can be added as separate responsibilities instead of being embedded into the main agent prompt.

## Terms

- **Source session**: the Ravi runtime session being observed.
- **Observer session**: a normal Ravi runtime session that consumes observation events for one source session.
- **Observer binding**: the durable relationship between one source session and one observer session.
- **Observer set**: all observer bindings attached to a source session.
- **Observer rule**: a declarative rule that decides when observer bindings are created. Rules are specified in `runtime/observation-plane/rules`.
- **Observer profile**: a declarative prompt-rendering profile that decides how observation events and deliveries are formatted for the observer session. Profiles are specified in `runtime/observation-plane/profiles`.
- **Observation event**: a canonical, Ravi-owned event selected for observer delivery.
- **Observation delivery**: a realtime or batched prompt sent to an observer session.
- **Observer mode**: the responsibility level granted to an observer: `observe`, `summarize`, `report`, or `intervene`.

## Core Model

The source session emits canonical runtime events as it already does today. The Observation Plane consumes those canonical events, matches observer bindings, applies event filters and delivery policies, and dispatches composed observation prompts to observer sessions through the normal Ravi session runtime.

The source session MUST NOT know which observer sessions exist. It MUST NOT receive observer prompts, observer state, or observer tool results.

Observer sessions are ordinary Ravi sessions with extra metadata:

- `observedSession`: source session key or id.
- `observedTaskId`: task id when the source session belongs to a task.
- `observerBindingId`: durable binding id.
- `observerMode`: `observe`, `summarize`, `report`, or `intervene`.
- `observerRuntimeProviderId`: optional runtime provider override for this observer session.
- `observerModel`: optional model override for this observer session.
- `observerProfileId`: optional observer profile used to render event and delivery prompts.
- `eventBatch`: selected observation event ids and compact payloads.

Observer bindings MAY carry explicit observer instructions from rule metadata. Those instructions apply only to the observer prompt. They MUST NOT be injected into the source session.

Observer bindings MAY carry explicit runtime selection from the matched rule. Runtime selection applies only to the observer session and MUST follow the same precedence model used by normal agent runtime config: binding/rule override first, then observer agent provider/model, then global runtime defaults.

Observer bindings MAY carry an observer profile snapshot. Profile snapshots apply only to observer prompt rendering and MUST NOT change source session prompts, observer rule matching, runtime permissions, or source event generation.

## Observer Modes

- `observe`: MAY inspect events and persist internal state. MUST NOT call side-effecting tools on behalf of the source session.
- `summarize`: MAY write summaries, artifacts, comments, or internal notes when explicitly permitted.
- `report`: MAY update task, project, progress, or operational status using explicitly granted tools.
- `intervene`: MAY send messages, block work, request human input, or alter flow only through a future explicit policy. This mode is out of scope for the initial implementation.

Modes are policy labels. Tool authorization remains enforced by Ravi permissions and context keys.

## Event Contract

Observation events MUST be derived from canonical Ravi runtime, tool, prompt, response, trace, task, or system events. The Observation Plane MUST NOT depend on raw provider-specific events.

The initial canonical observation event names are:

- `message.user`: compact user/source input for the current turn.
- `message.assistant`: compact assistant response chunks for the current turn.
- `tool.start`: compact tool invocation metadata.
- `tool.end`: compact tool completion metadata.
- `turn.complete`: source turn completed normally.
- `turn.failed`: source turn failed terminally.
- `turn.interrupt`: source turn was interrupted or converted into a recoverable interruption.

`turn.interrupt` is the Observation Plane event name even when lower runtime traces use provider/runtime-specific names such as `turn.interrupted`.

The default observer rule event filter MUST be intentionally small:

- `message.user`
- `message.assistant`
- `turn.complete`
- `turn.failed`
- `turn.interrupt`

Rules MAY opt in to tool events explicitly. The default MUST NOT include `tool.start` or `tool.end`.

Every observation event delivered to an observer MUST include:

- stable event id;
- source session id/key;
- event type;
- source turn id when available;
- monotonic source sequence when available;
- timestamp;
- redacted payload;
- payload hash when payload is truncated;
- provenance for task, agent, project, route, chat, or command when available.

Observation payloads SHOULD be compact. Full prompt text, tool outputs, attachments, or channel metadata MUST be redacted or summarized unless the observer binding explicitly permits them.

Observation events MAY be stored, traced, or audited as structured data. The primary observer prompt MUST be rendered into human-readable Markdown through an observer profile. Structured payload dumps MUST NOT be the default observer-facing format.

## Delivery

Observation delivery MUST be asynchronous by default. The source session MUST NOT wait for observer execution, observer completion, or observer tool calls.

Delivery policies:

- `realtime`: deliver one event or a small batch as soon as possible.
- `debounce`: collect matching events for a configured duration.
- `end_of_turn`: deliver after source `turn.complete`, `turn.failed`, or `turn.interrupt`.
- `manual`: materialize binding state but deliver only when explicitly invoked by an operator or scheduler.

Each delivery MUST be idempotent. The observer session MUST be able to ignore duplicate event ids.

The Observation Plane SHOULD support per-observer budgets for max events, max payload bytes, max prompt tokens, max runtime cost, and max executions per source turn.

Delivery rendering MUST happen in two phases:

1. Render each selected observation event with an event-type template from the observer profile.
2. Render the delivery envelope for the selected delivery policy with the rendered events and source/binding metadata.

If a profile does not define an event-specific template, the renderer MAY use a profile-level `event.default` template. The fallback MUST still produce readable Markdown and MUST NOT expose a raw structured dump as the primary format.

## Permission and Isolation

Observer sessions MUST have their own agent, session state, prompt, context key, runtime provider/model resolution, and permissions. They MUST NOT inherit tools, loaded skills, runtime context, source runtime provider/model, or channel permissions from the source session by default.

An observer MAY receive source metadata and compact event payloads because the binding grants that read capability. This read grant MUST be explicit and auditable.

Observer sessions MUST NOT be routed to external channel delivery unless their binding explicitly grants outbound behavior. Task-reporting observers SHOULD report through task/project tools, not through chat messages.

Observer sessions MUST NOT trigger observer bindings by default. Cascaded observation MAY be supported later, but it MUST require explicit opt-in to avoid recursive fan-out.

## Task Integration

Task execution SHOULD use observers to remove reporting burden from worker prompts.

For a task source session:

- the worker session SHOULD receive only the task objective, constraints, and working context needed to execute;
- a task progress observer MAY receive task objective, acceptance criteria, profile metadata, and selected source events;
- only the observer MAY be granted `tasks.report`, `tasks.block`, or `tasks.done` when the task profile delegates reporting to observers;
- observer reports MUST be idempotent and tied to source event ids or source turn ids.

The task service MUST NOT rely on hidden prompt instructions in the worker session to maintain status when an observer profile is configured for reporting.

## Invariants

- The Observation Plane MUST be event-driven. It MUST NOT poll provider internals.
- Source sessions MUST NOT wait for observer sessions in the default mode.
- Observer sessions MUST be isolated runtime sessions with their own state and permissions.
- Observer prompts MUST be composed from selected observation events and explicit observer instructions. They MUST NOT mutate the source session prompt, system prompt, loaded skills, or delivered user messages.
- Observer prompts MUST be rendered through observer profiles when a profile is configured. Hardcoded prompt envelopes are acceptable only as a system fallback profile.
- Observer runtime overrides MUST be carried as observer prompt metadata and resolved by the normal runtime launcher/dispatcher path. Provider adapters MUST NOT implement observer-specific runtime selection.
- Observer failures MUST be isolated. A failed observer MUST NOT fail or interrupt the source session unless a future explicit blocking-supervisor policy is enabled.
- Observer fan-out MUST be bounded by filters, delivery policies, budgets, or quotas.
- Observer selection MUST be deterministic for a given source session, rule set, and tag set.
- Observation events MUST be auditable through session trace, event replay, or a dedicated observation CLI.
- Observer sessions MUST NOT create recursive observers unless cascaded observation is explicitly enabled.
- Provider adapters MUST NOT implement observer behavior directly.

## Validation

- `bun test src/runtime/observation-plane.test.ts`
- `bun test src/runtime/runtime-event-loop.test.ts src/session-trace/session-trace.test.ts`
- `bun test src/tasks/service.test.ts`
- `bun run typecheck`
- `bun run build`

## Acceptance Criteria

- A source session can have zero, one, or many observer bindings.
- A source session with 30 configured observers continues its turn without waiting for observer execution.
- An observer binding can subscribe only to selected event types.
- An observer receives deterministic event batches rendered as readable Markdown with source session metadata and event ids.
- An observer rule can set observer runtime provider and model without creating a dedicated observer agent.
- An observer rule can select an observer profile without changing event matching or source session behavior.
- A failed observer run is recorded but does not fail the source turn.
- A task progress observer can update task progress without status-report instructions in the worker prompt.
- An observer cannot call tools unless its own runtime context grants those tools.
- Observer runs are visible through trace/events with source session and binding provenance.

## Known Failure Modes

- **Prompt contamination**: observer context is injected into the source prompt and changes worker behavior.
- **Synchronous fan-out**: source turns slow down or fail because the runtime waits for many observers.
- **Recursive observation loop**: observer sessions trigger observers which trigger more observers.
- **Permission leakage**: observer inherits source tools or channel authority unintentionally.
- **Event flood**: all events are sent to all observers without filters, causing high cost and noisy prompts.
- **Structured prompt leakage**: structured event payloads are dumped directly into the observer prompt, making profiles hard to iterate and increasing prompt noise.
- **Template drift**: profile templates diverge from available event fields and silently render empty or misleading prompts.
- **Provider coupling**: observer logic reads provider-specific stream data and breaks across adapters.
- **Duplicate reports**: retry delivery causes task progress or completion to be reported multiple times.
- **Privacy leak**: unrelated session, chat, contact, or task metadata is included in observation payloads.
