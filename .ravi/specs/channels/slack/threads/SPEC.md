---
id: channels/slack/threads
title: "Slack Threads"
kind: feature
domain: channels
capability: slack
feature: threads
capabilities:
  - slack
  - sessions
tags:
  - socket-mode
  - threads
  - session-fork
  - permissions
applies_to:
  - src/channels/slack/
  - src/channels/slack/thread-lifecycle.ts
  - src/channels/slack/thread-lifecycle-store.ts
  - src/router/resolver.ts
  - src/runtime/runtime-session-continuity.ts
  - src/prompt-builder.ts
  - src/runtime/runtime-system-prompt.ts
  - src/cli/commands/sessions.ts
owners:
  - dev
status: active
normative: true
---

# Slack Threads

## Intent

Slack threads are native branch points for Ravi sessions.

When a user replies in a Slack thread, Ravi MUST create or reuse a dedicated child session for that Slack `thread_ts`. The child session MUST remain separate from the channel-root session while inheriting the same agent, route, source identity, capabilities and permission boundary.

## Invariants

- A Slack channel or DM MUST remain the chat container.
- A Slack `thread_ts` MUST be modeled as thread context, not as the channel root.
- A Slack thread reply MUST route to a session whose key contains `:thread:<thread_ts>`.
- A Slack thread reply MUST NOT collapse back into a forced route session such as `ravi-hil`.
- If a route forces a parent session name and that parent exists, the thread child session key MUST be `<parent_session_key>:thread:<thread_ts>`.
- If no forced parent exists, the thread child session key SHOULD use the normal channel-derived parent key plus `:thread:<thread_ts>`.
- The child session MUST use the same agent and cwd as the route-resolved parent.
- The child session MUST receive the same resolved actor metadata as the inbound message: `actorType`, `contactId`, `platformIdentityId`, raw sender ids and identity provenance.
- Permission checks MUST evaluate the child thread turn with the same actor/source semantics as the parent channel turn.
- Runtime continuity MAY fork provider state from the parent session when the provider supports `supportsSessionFork`.
- Once the child session has its own resumable provider state, Ravi MUST prefer the child state over re-forking from the parent.
- Outbound responses from a thread child session MUST target the same Slack `thread_ts` by default.
- Presence for a thread turn SHOULD be anchored to the inbound Slack message in that thread.
- `thread.create` MUST publish the initial Slack root message through the durable
  native Slack outbound runner before creating the child session.
- A successful `thread.create` MUST use the root message `ts` as the Slack
  `thread_ts`, create or reuse the normal thread child session, attach the
  canonical thread chat and publish the same initial message as the child's
  first prompt.
- `thread.create --model <model>` MUST set the child session model override
  before its first prompt is published. Omitting `--model` MUST preserve normal
  inherited/default model resolution.
- Calling `thread.create` from an existing Slack thread MUST create a sibling
  root thread in the same Slack channel; Slack threads MUST NOT be nested.
- Thread creation and first-prompt publication MUST be idempotent across
  outbound retries and repeated delivery observations.
- An inbound reply that arrives before the programmatic first prompt MUST NOT
  cancel that prompt or emit a second `ravi.inbound.thread.created` event.
- Programmatic `ravi.inbound.thread.created` events MUST include the child
  `agentId`, matching the normalized manual-thread event contract.
- `thread.close` MUST be an internal Ravi lifecycle transition. It MUST NOT
  delete or mutate the Slack root message.
- Closing without a return value MUST be silent to the parent session. Closing
  with a return value MUST publish one structured completion event to the
  parent session and MUST NOT publish it twice.
- Closing an already closed thread MUST be idempotent.
- A later inbound Slack reply MAY reopen the same child session and lifecycle;
  it MUST NOT create a replacement fork.
- Reopening a thread MUST preserve any parent completion that is still pending
  delivery.
- A non-sentinel Slack session whose context can run the `sessions` group MUST
  get the "Slack Threads" system prompt section. A channel-root or DM session
  MUST be told to open a thread with `thread.create` for work that strays from
  the conversation, and to fall back to the current conversation when
  `thread.create` fails or is unavailable. A thread child session (key with
  `:thread:`) MUST be told to keep its work in the thread, to open a sibling
  thread for a different subject, and how to close with or without `--return`.
- The channel-root session MUST be able to orchestrate its threads:
  `thread.list` lists the threads whose parent is that session (open by
  default), and `thread.send` publishes new instructions to one of them as a
  `[System] Execute: [from: <parent>]` turn sourced in the Slack thread.
  `thread.send` MUST be refused from a thread child and for a thread whose
  first turn has not started, and MUST reopen a closed thread without dropping a
  pending parent completion.
- A thread child MUST be able to send progress to its parent with
  `thread.report` without closing the thread. No `access session` grant is
  needed for `thread.report` or `thread.send`: the parent/child relation is the
  authority, and both stay within one agent.
- Every parent notice (report or close return) MUST name the thread by the first
  line of its initial message, when it has one, and its child session name, and
  MUST include a Slack link when the workspace id is known. The link MUST be a
  `slack://channel?team=<team>&id=<channel>&thread_ts=<ts>` app link, since
  `https://app.slack.com` links always open the browser. It MUST be sourced
  at the channel root, never inside the thread.

## Route Semantics

`route.session` means "root/base session" for Slack channel roots.

For Slack thread replies, `route.session` MUST NOT be interpreted as "always send this turn to exactly that runtime session". Instead, it is the parent session used to derive the child fork.

Example:

```text
route.session = ravi-hil
slack thread_ts = 1713000000.000100

parent session key = ravi-hil
child session key  = ravi-hil:thread:1713000000.000100
child session name = ravi-hil-t-1713000000000100
```

Programmatic creation follows the same mapping. The action caller can be the
channel-root session or one of its thread children, but the new Slack thread is
always rooted in the channel and its child session is derived from the
channel-root parent.

## Session Actions

```bash
ravi sessions create-thread "<initial message>" [--model <model>]
ravi sessions close-thread [--return "<result>"]
ravi sessions report "<progress>"
ravi sessions threads [--all] [--json]
ravi sessions thread-send <thread> "<instructions>"
```

- Both commands infer the current session and Slack surface from tool context.
- `create-thread` is available only when an executable Slack surface exists.
- `close-thread` is available only inside an open Slack thread child session.
- `--return` opts into the parent completion event; omission is intentionally
  silent.
- `report` is available only inside a Slack thread child session.
- `threads` lists the channel-root session's threads, from the root or any of
  its children. `thread-send` names a thread by child session name or key,
  request id or Slack `thread_ts`, and works only from the channel-root session.
- `report`, `close-thread` and `thread-send` refuse with typed codes, never a
  bare command failure: `THREAD_NOT_THREAD_CHILD`, `THREAD_IDENTITY_MISMATCH`
  (the session has an open thread's name under another key), and for
  `thread-send` `THREAD_NOT_CHANNEL_ROOT`, `THREAD_NOT_FOUND`,
  `THREAD_NOT_STARTED`, `THREAD_SESSION_MISSING`; also
  `THREAD_PARENT_MISSING` and `THREAD_PARENT_RETURN_PENDING`. The remote relay
  renders local copy for each code.
- A thread record can outlive its child session. `threads` MUST mark that
  thread with `childSessionMissing: true` and MUST NOT report it as unstarted.
- Renaming a session MUST update the thread registry's saved child and parent
  names, so an open thread stays bound to its child's current name.

## Root Card

The root of a programmatic thread is one Slack `card` block, not the initial
message as plain text: the first line is the title, the latest progress or
result the subtitle, a summary of the rest of at most 200 characters the body,
and a status line (status, who asked, when it changed, whether the brief was
cut) the subtext. When Slack rejects the `card` block (`invalid_blocks`), the
same content is sent once more as classic blocks (header, sections, context).

Who asked is the contact who wrote the turn running `create-thread`, from the
daemon's record of the turn; the operator's own turns (and the terminal) fall
back to the `permission-owner` contact; agents, routines and unknown turns
name no one.

When the summary leaves part of the message out, the whole message is posted
as the first reply inside the thread. `report` (latest progress),
`close-thread` (closed, with the `--return` result) and a `thread-send` that
reopens the thread update the card in place. The card shows only text that
passed the outbound Knowledge guard, plus who asked. A thread a person started
keeps their message as root; Ravi never edits it.

## Acceptance Criteria

- Replying to a Slack message in a thread creates or reuses a child session distinct from the route-forced parent.
- The child session subscribes to the canonical Slack thread chat.
- The prompt `source.threadId` equals Slack `thread_ts`.
- The canonical chat platform id is `<channel_id>#<thread_ts>`.
- The first child turn can fork from parent provider state when available and supported.
- Follow-up replies in the same Slack thread reuse the same child session.
- Responses from the child stay inside the Slack thread.
- Programmatic creation posts exactly one Slack root and starts exactly one
  child turn.
- The programmatic root is a status card; report, close and reopen update it.
- The selected model is visible on the child session before the child turn.
- Internal close is durable and an optional parent return is delivered once.
