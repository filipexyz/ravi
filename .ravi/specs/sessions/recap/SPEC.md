---
id: sessions/recap
title: Session Recap
kind: capability
domain: sessions
capability: recap
capabilities:
  - recap
  - session-projection
tags:
  - sessions
  - recap
  - cli
  - computed
applies_to:
  - src/sessions/recap.ts
  - src/sessions/recap.test.ts
  - src/cli/commands/sessions.ts
  - src/cli/commands/sessions.test.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Session Recap

## Intent

A session recap is a bounded, deterministic *projection of one session*.
Another agent (or an operator) can ask "what happened in that chat" without
dumping the full transcript, reading agent-scoped `MEMORY.md`, or consulting
Knowledge threads.

`ravi sessions recap <nameOrKey>` computes the recap on read from existing
stores. Sessions remain the owner.

## Boundary

Session recap owns:

- the recap object shape for one `session_key`;
- the computed `ravi sessions recap` command (human + `--json`);
- advertising `session.recap` on `ravi sessions actions --json`.

Session recap does NOT own:

- session identity or attach (owned by `sessions` / `sessions/attach`);
- Knowledge threads or semantic curation (owned by `knowledge`);
- portable subject briefs (owned by `threads` / `threads/session-handoff`);
- agent-cwd memory files (`MEMORY.md`, `memory/YYYY-MM-DD.md`);
- provider compaction, persist-on-compact, or FTS / `session_search`.

Recap MUST NOT be confused with:

- `sessions read` — recent user/assistant transcript only;
- `sessions trace` — operational ledger;
- Knowledge — semantic topics that outlive one session;
- agent `MEMORY.md` — agent-scoped notes written by a PreCompact hook.

## v0 Scope

v0 is **computed on read**. It MUST NOT:

- add a recap column or table;
- persist a recap on compact;
- write or read `MEMORY.md`;
- auto-inject recap text into the live system prompt;
- implement FTS or `session_search`;
- invent narrative with an LLM.

Persist-on-compact and session search are out of v0. Those MAY land later as
writers/indexes of this same projection. They MUST NOT change `session_key`
stability, attach vs history, or visibility rules in `sessions`.

## Projection Sources

The recap MUST be assembled from stores that already exist:

- the session row (`session_key`, `name`, `agent_id`, `display_name`,
  `compaction_count`, `created_at`, `updated_at`);
- `session_goals` when a row is present;
- the same recent history used by `sessions read` (user/assistant only, tools
  omitted).

Missing or empty sources MUST produce empty fields, not a crash and not
invented text.

## Recap Shape

The payload MUST include:

- `schemaVersion`;
- `computed: true` and `persisted: false` for v0;
- session identity: `sessionKey`, `name`, `agentId`;
- cheap session metadata already on the row when present (`displayName`,
  `compactionCount`, `createdAt`, `updatedAt`);
- `goal` — the current session goal or `null`;
- `summary` — `null` in v0 unless a later persisted source exists;
- `pinned`, `decisions`, `openLoops` — arrays that MAY be empty;
- `recent` — a bounded tail of user/assistant messages with limit, total,
  truncation flags, and the history source.

`openLoops` MAY include a blocked goal's `blockedReason` when that field is
present. v0 MUST NOT derive summary, pinned items, or decisions from an LLM
or from heuristic rewriting of the tail.

The recent tail MUST:

- omit tool calls (same honesty as `sessions read`);
- be bounded by default (default 8, max 40);
- truncate long message text and mark `textTruncated`;
- remain valid when history is empty (`available: false`, `items: []`).

## Command

```bash
ravi sessions recap <nameOrKey> [-n count] [--json]
```

`<nameOrKey>` MAY be omitted only when the caller already has a current
session context (same default as `sessions read` / `sessions actions`).

`--json` MUST print the recap object as the stdout payload. Human output MUST
be compact and MUST NOT dump an unbounded transcript.

## Authorization

Recap is a session read. Authorization MUST match `sessions read`:

- `access session:<id>` authorizes recap beyond the current own session;
- a chat attached to a session is not permission to recap that session;
- unauthorized or hidden sessions MUST appear missing (`SESSION_NOT_FOUND`);
- the command MUST NOT suggest other session names on not-found.

## Actions Catalog

`ravi sessions actions --json` MUST advertise `session.recap` as an available
session action, independent of channel capabilities, the same way it
advertises `session.read`.

## Invariants

- Recap is a projection of one session. It MUST NOT merge history from another
  session, DM, or group.
- Recap MUST NOT persist. Computing it twice MAY differ only when the
  underlying stores changed.
- Recap MUST NOT rewrite `session_key`.
- Recap MUST NOT be injected into the live system prompt.
- Empty history is a valid empty recap.

## Validation

```bash
bun test src/sessions/recap.test.ts src/cli/commands/sessions.test.ts
```
