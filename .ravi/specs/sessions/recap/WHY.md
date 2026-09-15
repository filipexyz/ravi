---
id: sessions/recap/why
title: "Session Recap — Why"
kind: capability
domain: sessions
capability: recap
status: draft
normative: false
---

# Why Session Recap Exists

## Problem

Another agent often needs "what happened in that chat" without becoming a
second reader of the full transcript. Today the options are the wrong size:

- `sessions read` returns the last N user/assistant messages, no structure;
- `sessions trace` is an ops ledger, not a conversation brief;
- provider compaction and the Claude PreCompact hook write `MEMORY.md` in the
  *agent cwd*, which is agent-scoped, not session-scoped, and is not a
  permission-checked API;
- Knowledge threads are semantic topics that outlive one session.

There is no session-scoped recap object and no `sessions recap` command.

## Decision

Ship a short normative recap as a child of the sessions domain, plus a
*computed* CLI that another agent can call. v0 reads existing stores and
projects a bounded object. No new table. No persist-on-compact. No FTS.

## Why Sessions Own It

The recap is identified by `session_key` and answers questions about one
runtime container. Knowledge and `MEMORY.md` answer different questions
(topic continuity; agent memory). Putting recap under sessions keeps
`session_key` stability, attach vs history, and visibility in one owner.

## Why Computed, Not Persisted

A persisted recap needs a writer (compact hook or curator) and a migration.
The first useful slice is a read-side projection another agent can call now.
Persist-on-compact can later write the same shape without changing the
command contract.

## Why No LLM Summarizer In v0

Determinism beats a cheap-looking paragraph. Empty `summary` / `pinned` /
`decisions` fields tell the caller the source does not have them. An optional
summarizer MAY be added later, off by default.

## Why The Prompt Names Recap But Does Not Inject It

The Session Boundary used to say "never recover missing context from another
session." That blocked the actual use case: another agent pulling a recap of a
session it is allowed to see. Naming `ravi sessions recap --json` teaches the
allowed path. Injecting the recap body would dump session state into every
turn and reopen the MEMORY.md-in-prompt debate.

## Why Not Unify Transcript Split

`sessions read` already has a chat-db / chat-id / metadata / provider-transcript
fallback. Recap reuses that tail. Unifying the #281 transcript split is a
separate problem and MUST NOT block this slice.
