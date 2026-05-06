# Observation Plane / WHY

## Rationale

The main agent prompt is the wrong place for cross-cutting runtime responsibilities. Task status reporting, quality review, memory extraction, safety checks, cost monitoring, and operational alerts compete with the user's actual task and make worker prompts heavier and less reliable.

The Observation Plane separates execution from supervision. The source session keeps doing the primary work. Observer sessions receive selected events and own their specialized responsibility.

## Why a Plane, Not One Watcher

The target model supports many observers per source session. A single "watcher" abstraction is too narrow because responsibilities need independent prompts, permissions, schedules, and budgets.

Examples:

- task progress observer;
- quality observer;
- memory observer;
- cost observer;
- policy observer;
- artifact lineage observer;
- user sentiment observer.

Each observer can evolve independently without changing the worker prompt or source runtime contract.

## Why Sessions

Observers are modeled as sessions because Ravi already has session state, provider execution, prompt composition, tool authorization, traceability, and durable lifecycle around sessions.

Using normal sessions avoids a second execution substrate. It also lets each observer use different agents, models, skills, context keys, and permissions.

## Rejected Alternatives

- **Put all instructions in the worker prompt**: rejected because it makes workers responsible for monitoring themselves and inflates every task prompt.
- **Use provider hooks directly**: rejected because hooks are provider-specific and should not own Ravi-level task, project, routing, or permission behavior.
- **Fork the source session**: rejected because forked history is too heavy and leaks prompt context. Observers need selected events, not the full source conversation.
- **Make observers blocking by default**: rejected because fan-out to many observers would make source sessions slow and fragile.
- **Use only logs/events without sessions**: rejected because observers need reasoning, memory, tool permissions, and durable state.

## Tradeoffs

The plane adds orchestration complexity: rule matching, event filtering, delivery idempotency, budgets, and failure handling. That complexity is justified only if the implementation keeps the source session isolated and asynchronous.

The first implementation SHOULD prefer a passive observer and a task reporter observer over general intervention. Blocking supervision can be added later with a stricter policy model.
