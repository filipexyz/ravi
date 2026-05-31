---
id: a2a/server
title: "A2A Server Exposure"
kind: capability
domain: a2a
capability: server
tags:
  - a2a
  - server
  - agent-card
  - gateway
  - authorization
applies_to:
  - src/a2a/auth.ts
  - src/a2a/server.ts
  - src/gateway.ts
  - src/runtime/session-dispatcher.ts
  - src/router/sessions.ts
  - src/artifacts/
owners:
  - ravi-dev
status: draft
normative: true
---

# A2A Server Exposure

## Intent

A2A server exposure lets external A2A clients call selected Ravi agents through
standard Agent Cards and task endpoints. This is a later phase after registry
and client invocation are stable.

## Rules

- A Ravi agent MUST NOT be exposed over A2A by default.
- Exposure MUST be opt-in per agent and SHOULD require an explicit public name,
  description, skill list, input modes, output modes, security requirements,
  and allowed runtime surface.
- Generated Agent Cards MUST omit internal cwd, local prompt text, context
  keys, provider session ids, raw channel ids, private tool names, and secrets.
- Public Agent Cards MAY be served from `/.well-known/agent-card.json` when a
  deployment exposes exactly one public A2A agent. Multi-agent deployments
  SHOULD serve cards under explicit ids and use a routing-aware discovery path.
- Inbound A2A requests MUST create or resolve a Ravi session using a synthetic
  A2A source, not a WhatsApp/Omni chat source.
- Inbound A2A requests MUST pass through Ravi permission, runtime dispatch,
  queue, delivery barrier, trace, and artifact handling.
- Inbound A2A tasks MUST NOT automatically emit to external chat channels. Any
  visible channel output must come from normal Ravi tools/actions authorized for
  the called agent.
- A2A task state MUST map terminal Ravi runtime events to A2A task terminal
  states exactly once.
- A2A streaming/push support MUST preserve ordered chunks and terminal events.
- Server endpoints MUST authenticate clients before exposing extended Agent
  Cards, private skills, or task state.
- Server endpoints MUST authorize every operation after authentication:
  send/stream, get task, list tasks, cancel, subscribe, push notification
  config, and extended Agent Card retrieval.
- Task reads and task lists MUST be scoped to the authenticated external caller
  before any state lookup that could reveal resource existence.
- Public Agent Cards MAY expose safe capability summaries. Extended Agent Cards
  MUST require authentication and MAY vary by caller identity/authorization.
- The generated Agent Card `securitySchemes`, top-level `security`, and
  skill-level requirements MUST match the actual server enforcement path.
- Push notification configuration MUST authenticate callback ownership, store
  callback credentials securely, require HTTPS by default, and reject private or
  localhost callback URLs unless an explicit dev policy allows them.

## Mapping

- A2A `Message` from client -> Ravi prompt item with A2A source metadata.
- A2A `contextId` -> Ravi thread or A2A session correlation.
- A2A task id -> durable server-side A2A task record.
- Ravi assistant response -> A2A message or task status update.
- Ravi artifacts -> A2A artifacts with text, file, or data parts.

## Acceptance

- A selected Ravi agent can publish a safe Agent Card.
- A client can send a basic message and receive a task or message response.
- A long-running Ravi turn can be observed through polling or streaming.
- Disabled agents and unauthorized clients receive protocol-shaped errors.
- `401` and `403` are distinct and do not leak private agent/task existence.

## Known Failure Modes

- Accidentally exposing every local agent because an Agent Card generator reads
  all `agents` rows.
- Leaking local runtime instructions or credentials through Agent Card fields.
- Routing inbound A2A traffic into a live WhatsApp chat by reusing channel
  source metadata.
- Reporting a task as completed before artifacts are persisted.
- Serving an extended Agent Card publicly or with stale authorization.
