---
id: quality
title: "Runtime Quality"
kind: domain
domain: quality
capabilities:
  - failure-modes
  - root-cause-packets
  - watch-windows
  - triage
tags:
  - quality
  - observability
  - runtime
  - agents
  - nexus-pattern
applies_to:
  - src/runtime
  - src/session-trace
  - src/insights
  - src/tasks
  - src/projects
  - src/cli/commands
owners:
  - ravi-dev
status: draft
normative: true
---

# Runtime Quality

## Intent

Runtime Quality is Ravi's production agent failure intelligence layer. It turns traces, events, logs, user behavior, task state, and artifacts into high-signal failure modes, root-cause packets, tasks, insights, and watch windows.

The domain exists because raw observability is not enough. A trace says what happened; quality says whether the agent behavior was bad, why it matters, what evidence proves it, and what operational object should carry the fix.

## Boundaries

- Quality MUST observe Ravi-owned runtime data: sessions, traces, events, tasks, artifacts, projects, daemon logs, cron runs, and channel metadata.
- Quality MUST NOT replace the runtime event loop, session trace store, task runtime, or project model.
- Quality MUST NOT treat every exception as a product failure. It classifies behavior against explicit failure modes.
- Quality MUST NOT alert on every occurrence. It deduplicates, groups, and escalates only when the signal is material.
- Quality MAY inspect Omni events as channel evidence, but Omni remains transport. Ravi owns session, task, agent, and policy semantics.

## Core Model

Quality moves through this pipeline:

```text
events/traces/logs/tasks
-> failure mode detection
-> issue candidate
-> dedupe and severity
-> root-cause packet
-> task, insight, project link, or watch window
-> post-fix validation
```

## Invariants

- Every failure mode MUST have a stable id, owner, scope, severity policy, evidence contract, and default action.
- A detected issue MUST include enough evidence for another agent to reproduce or reason about it without rereading the whole session.
- Root-cause packets MUST be persisted as artifacts or durable task context, not only sent as chat messages.
- Dedupe MUST happen before user notification unless the failure is safety-critical or externally visible.
- A fixed issue MUST enter a watch window when recurrence is plausible.
- A watch window MUST define success criteria and a close/reopen rule.
- Quality MUST distinguish:
  - provider/adapter bugs
  - Ravi host/runtime bugs
  - tool implementation bugs
  - prompt/skill/instruction bugs
  - user/context ambiguity
  - external channel/API failures
- Quality MUST NOT create tasks for low-confidence observations unless the task is explicitly framed as investigation.
- Quality SHOULD create insights for durable learnings that do not require code or config changes.
- Quality SHOULD link findings to Projects when a workstream already exists.

## Canonical Failure Families

- Runtime liveness: stalled turns, missing terminal events, stuck tools, queue starvation.
- Tool lifecycle: synthetic completion, missing confirmation, double completion, failed side effects reported as success.
- Context integrity: wrong session, chat bleed, stale history, incorrect source attribution.
- Instruction adherence: ignored direct instruction, unauthorized mutation, approval bypass.
- User friction: repeated rephrasing, unresolved clarification loops, visible frustration.
- Task integrity: done without artifact, blocked without owner, task cascade without validation.
- Routine integrity: silent cron, heartbeat blind spot, repeated check-in ignored.

## Action Mapping

- `task`: use when code, config, migration, test, or operational fix is needed.
- `insight`: use when the durable output is a lesson, pattern, or decision rule.
- `project link`: use when the issue belongs to an active workstream.
- `watch`: use after a fix or when recurrence should be monitored.
- `silent record`: use when evidence is useful but not actionable.

## Acceptance Criteria

- A recurring runtime incident can be reduced to one grouped quality issue with trace evidence and a proposed owner.
- A post-fix watch window can close automatically after its success criteria pass.
- An agent receiving a quality task has the failure mode, evidence, suspected boundary, validation plan, and no need to ask for basic context.
- Quality findings are visible through CLI and can be consumed as JSON.
