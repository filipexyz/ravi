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
```

- Both commands infer the current session and Slack surface from tool context.
- `create-thread` is available only when an executable Slack surface exists.
- `close-thread` is available only inside an open Slack thread child session.
- `--return` opts into the parent completion event; omission is intentionally
  silent.

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
- The selected model is visible on the child session before the child turn.
- Internal close is durable and an optional parent return is delivered once.
