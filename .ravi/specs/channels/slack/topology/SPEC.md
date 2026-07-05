---
id: channels/slack/topology
title: "Slack Topology"
kind: feature
domain: channels
capability: slack
feature: topology
capabilities:
  - slack
  - routes
  - sessions
tags:
  - slack
  - topology
  - routing
  - sessions
applies_to:
  - src/channels/slack/
  - src/cli/commands/slack.ts
  - src/router/
owners:
  - dev
status: active
normative: true
---

# Slack Topology

## Intent

Slack topology is the agent-facing map of visible Slack channels and Ravi runtime ownership.

Ravi MUST distinguish Slack channel identity from Ravi runtime sessions.

## Terms

- Slack channel: a Slack conversation returned by `conversations.list`.
- Ravi route: the rule that chooses the agent and optional canonical session for a Slack channel.
- Ravi session: runtime state for an agent.
- Slack custom sidebar section: a user-specific Slack client organization feature that Ravi does not currently read or model.

## Invariants

- Agent JSON MUST NOT call Slack custom sidebar sections "sessions".
- Agent JSON MUST expose Slack channel identity and Ravi session state as different fields.
- Topology reads MUST NOT create Ravi sessions.
- Topology reads MUST NOT mutate Slack.
- Topology output MUST include route status for every visible Slack channel.
- Topology output MUST distinguish route matching from inbound policy admission.
- A Slack channel matched only through account/default fallback MAY still be blocked by instance policy such as `groupPolicy=allowlist`.
- Topology output MUST expose an inbound policy gate for every visible Slack channel.
- Topology output MUST NOT include Slack `usergroups.*` as sections.
- Topology output MUST NOT imply custom sidebar sections are readable by the current bot-token path.
- Private Slack channels not visible to the bot MAY be absent and MUST NOT be inferred.

## Canonical Shape

Topology responses SHOULD follow this shape:

```json
{
  "channels": [],
  "ungroupedChannelIds": [],
  "accountId": "ravi-rbbt-slack",
  "capabilities": {}
}
```

Each channel entry MUST include:

- Slack identity: `id`, `name`, `isPrivate`, `isMember`.
- Ravi route: `matched`, `agentId`, `sessionKey`, `routePattern`, `routeSession`, `dmScope`, `policy`.
- Ravi inbound gate: `policyGate.inboundAllowed`, `policyGate.reason`, `policyGate.explicitRoute`, `policyGate.effectivePolicy`, `policyGate.instancePolicy`, and optional `policyGate.contactStatus`.

## Boundary

The Slack adapter owns Slack API normalization for visible conversations.

The router owns route matching.

The topology helper owns read-only composition of Slack channels, Ravi route metadata and inbound policy metadata.

The topology helper MAY read contact/chat allowlist status through an injected resolver, but it MUST NOT create contacts, sessions, routes or pending records while rendering topology.

Slack custom sidebar sections MAY return later only as a separate feature with the correct credential model. Until then, user groups MUST NOT be used as a proxy for sections.
