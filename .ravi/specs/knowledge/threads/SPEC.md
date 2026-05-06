---
id: knowledge/threads
title: "Knowledge Threads"
kind: capability
domain: knowledge
capability: threads
capabilities:
  - semantic-threads
  - topic-continuity
tags:
  - knowledge
  - threads
  - sessions
applies_to:
  - src/knowledge
  - src/sessions
  - src/tasks
owners:
  - ravi-dev
status: draft
normative: true
---

# Knowledge Threads

## Intent

Knowledge threads are durable semantic topics.

They exist because the same topic can live across many runtime sessions, channels, tasks, projects, artifacts, reviews, and days.

## Boundary With Sessions

`knowledge_thread` is not `session`.

Use a session for live runtime interaction.

Use a knowledge thread for semantic continuity.

A thread MAY create or reuse curation sessions, but the thread state MUST live in Knowledge, not in the runtime session.

## Thread Identity

Thread slugs SHOULD be stable, lowercase, and human readable.

Examples:

- `ravi-knowledge-layer`
- `runtime-session-pool`
- `rapha-content-pipeline`
- `state-base-review`
- `trt-workflow`

Slugs MAY change, but the thread id MUST remain stable.

## Thread Scope

A thread MAY be scoped to:

- `global`
- `contact:<contact_id>`
- `agent:<agent_id>`
- `chat:<chat_id>`
- `session:<session_key>`
- `project:<project_id>`
- `task:<task_id>`
- `tag:<tag_slug>`

Scope is not ownership.

Scope says where the topic primarily belongs. Ownership says who is responsible for maintaining it.

## Thread Lifecycle

Allowed statuses:

- `active`: topic is live.
- `watch`: topic is not primary but should remain visible.
- `blocked`: thread needs a specific input or event.
- `closed`: topic reached a stable closure.
- `stale`: topic has not had a signal in its expected cadence.
- `archived`: retained for history.

Status changes MUST append an event.

## Thread Sessions

Curator sessions SHOULD use predictable names:

```text
knowledge:thread:<thread-slug>
knowledge:curator:<profile-id>:<thread-slug>
```

These sessions are scratchpads and execution surfaces. They MUST be recreated safely and MUST NOT be required to reconstruct the thread.

## Thread Signals

`last_signal_at` SHOULD update when:

- a new source is attached;
- a canonical item changes;
- a curator drafts new material;
- a publisher updates a publication;
- an operator marks the thread active/watch/closed.

Reading a thread without learning anything new SHOULD NOT update `last_signal_at`.

## Thread Summaries

Each active thread SHOULD maintain:

- current objective;
- last real closure;
- next unblock;
- open loops;
- risks;
- what not to touch now;
- source coverage.

This matches the workstream reviewer shape, but the Knowledge Layer keeps it reusable and queryable.

## Thread Merge

Threads MAY be merged.

Merge MUST:

- pick one surviving thread id;
- keep aliases for old slugs;
- move all items and sources;
- preserve publication history;
- append an audit event.

## Acceptance Criteria

- A thread can link sources from at least two sessions.
- A thread can have multiple curation sessions without losing canonical state.
- A thread can publish to Obsidian and still remain canonical in Ravi.
- Thread listing is bounded by default.
- Thread explain output can show why it contains each item.
