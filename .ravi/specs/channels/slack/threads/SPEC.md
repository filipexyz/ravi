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

## Acceptance Criteria

- Replying to a Slack message in a thread creates or reuses a child session distinct from the route-forced parent.
- The child session subscribes to the canonical Slack thread chat.
- The prompt `source.threadId` equals Slack `thread_ts`.
- The canonical chat platform id is `<channel_id>#<thread_ts>`.
- The first child turn can fork from parent provider state when available and supported.
- Follow-up replies in the same Slack thread reuse the same child session.
- Responses from the child stay inside the Slack thread.
