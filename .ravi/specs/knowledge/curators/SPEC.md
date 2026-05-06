---
id: knowledge/curators
title: "Knowledge Curators"
kind: capability
domain: knowledge
capability: curators
capabilities:
  - curator-agents
  - scheduled-curation
  - topic-sessions
tags:
  - knowledge
  - agents
  - cron
  - sessions
applies_to:
  - src/knowledge/curators
  - src/cron
  - src/agents
  - src/sessions
owners:
  - ravi-dev
status: draft
normative: true
---

# Knowledge Curators

## Intent

Knowledge curators are specialized agents that transform source material into draft knowledge.

They provide attention specialization without creating more unmanaged memory.

## Boundary

Curators draft.

Publishers canonicalize and materialize.

Curators MUST NOT send outbound messages, mutate external systems, or answer as Luis unless an explicit approval path grants that behavior.

## Initial Curators

Initial curator roles SHOULD include:

- `knowledge-router`: decides which thread/profile should receive a source.
- `workstream-curator`: extracts objective, closure, unblock, risks, and do-not-touch.
- `social-curator`: extracts people, emotional weight, unanswered asks, and response windows.
- `decision-curator`: extracts decisions, reasons, alternatives, reversals, and wins.
- `state-base-curator`: extracts sleep, food, water, meds, body, home, and energy signals.
- `vault-publisher` or `ravi-vault`: publishes reviewed/canonical knowledge to Obsidian.

## Cron Model

Crons SHOULD run curators on bounded windows.

Example cadence:

```text
08:20 social-curator      -> yesterday/today social loops
08:30 workstream-curator  -> active projects and tasks
09:10 state-base-curator  -> daily base signal
14:30 knowledge-router    -> hot sessions and new threads
20:30 decision-curator    -> decisions and wins of the day
21:00 vault-publisher     -> publish reviewed threads
```

Crons MUST record source windows and profile snapshots.

Crons MUST NOT run all-time ingestion by default.

## Topic Sessions

Curators MAY create topic sessions to structure reasoning:

```text
knowledge:curator:<profile>:<thread>:<date>
```

These sessions SHOULD be ephemeral or TTL-bound.

The canonical output MUST be written to Knowledge, not left only in the session transcript.

## Permissions

Default curator permissions:

- read allowed sources;
- read knowledge threads/items;
- create draft items;
- attach sources;
- propose merges;
- propose publication.

Default curator restrictions:

- no outbound channel writes;
- no agent/session/route/cron mutation;
- no task status mutation unless separately granted;
- no canonical publication unless it is the publisher role.

## Handoff Shape

Curator output SHOULD be structured:

```text
Thread:
Source window:
Draft items:
  - kind / title / confidence / evidence / sources
Merges proposed:
Open questions:
Next curation step:
```

## Approval Ladder

The operating ladder SHOULD be:

1. observe and draft;
2. recommend merge/publication;
3. request approval;
4. publish automatically only for low-risk configured surfaces;
5. intervene or outbound only through a future explicit policy.

## Acceptance Criteria

- A curator run writes drafts with source links.
- A curator run can be replayed without duplicating items.
- Curator sessions can expire without losing canonical knowledge.
- A publisher can consume curator drafts and materialize a note.
- Curators cannot write outbound messages by default.
