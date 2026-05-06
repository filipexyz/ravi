---
id: quality/root-cause-packets
title: "Root Cause Packets"
kind: capability
domain: quality
capability: root-cause-packets
capabilities:
  - evidence
  - artifacts
  - tasks
  - handoff
tags:
  - quality
  - root-cause
  - artifacts
applies_to:
  - src/artifacts
  - src/tasks
  - src/insights
  - src/projects
owners:
  - ravi-dev
status: draft
normative: true
---

# Root Cause Packets

## Intent

A root-cause packet is the durable body of a quality finding. It gives a worker enough context to fix or validate the issue without replaying the entire operational history.

## Required Sections

Every packet MUST include:

- `summary`: one sentence describing the failure.
- `impact`: why the failure matters.
- `timeline`: concrete timestamps and event ids when available.
- `expected`: what should have happened.
- `observed`: what actually happened.
- `evidence`: trace/log/task/artifact references.
- `suspected_boundary`: runtime, provider, tool, channel, prompt, skill, or user-context.
- `confidence`: low, medium, or high.
- `next_action`: task, insight, watch, project link, or silent record.
- `validation`: commands or observations that prove the fix.

## Invariants

- Packets MUST be persisted as artifacts or task context.
- Packets MUST NOT contain secrets, credentials, API keys, or private outbound content beyond the minimum needed evidence.
- Packets MUST include source references instead of copying large transcripts.
- Packets SHOULD include a minimal reproduction path when code is involved.
- Packets SHOULD link to a watch window after a deployed fix.
- Packets MAY include candidate files, but MUST label them as inference unless directly proven.

## Handoff Contract

When a packet creates a task, the task instructions MUST include:

- failure mode id
- packet artifact id or path
- acceptance criteria
- validation command
- explicit non-goals
- deployment/watch requirement if live behavior is affected

## Quality Bar

A packet is not ready if the next worker still has to ask:

- what failed?
- where is the trace?
- why is this important?
- what boundary is suspected?
- how do I know the fix worked?
