---
id: a2a
title: "Why Agent-to-Agent Interop"
---

# Why

The public Agent2Agent (A2A) protocol reached a stable 1.0 specification and is
designed around independent, opaque agents discovering each other, negotiating
modalities, managing shared tasks, and exchanging results without sharing
internal memory or tools.

Ravi already has strong local primitives: agents, sessions, runtime providers,
context keys, tasks, artifacts, SDK gateway commands, and NATS events. A2A
should sit above those primitives as an interop boundary, not replace them.

## Design Decisions

- Use a dedicated `a2a` domain because remote agents are neither local Ravi
  agents nor provider adapters.
- Make registry the first primitive because safe programmatic calls need a
  known target, selected interface, version, trust state, credentials, and
  audit identity.
- Add `a2a/auth` as its own capability because the A2A protocol advertises
  security schemes but deliberately leaves caller authorization, credential
  acquisition, and task scoping to the implementation.
- Use decorated CLI commands as the external API source of truth so gateway and
  SDK exposure stay aligned with the existing Ravi SDK contract.
- Materialize artifacts through Ravi artifacts so remote outputs can be reused,
  traced, and inspected by agents later.
- Default asynchronous remote updates to follow-up delivery because remote A2A
  updates are system/external events, not human foreground input.

## External References

- A2A latest spec: https://a2a-protocol.org/latest/specification/
- A2A enterprise security guidance:
  https://a2a-protocol.org/latest/topics/enterprise-ready/
- A2A discovery and Agent Card protection:
  https://a2a-protocol.org/latest/topics/agent-discovery/
- Agent Card well-known path: `/.well-known/agent-card.json`
- Core protocol concepts: Agent Card, AgentSkill, AgentInterface, Task, Message,
  Part, Artifact, streaming, push notifications.
- A2A/MCP relationship: A2A delegates between peer agents; MCP connects an agent
  to tools, APIs, and resources.
- Security reading: A2A identity lives at the HTTP/transport layer, credentials
  are acquired out of band, Agent Cards declare supported schemes, and each
  server defines its own authorization model. Ravi therefore must not treat an
  Agent Card as trust, permission, or credential material.

## Alternatives Rejected

- Reuse `sessions ask/answer` as the public A2A implementation. This is useful
  for internal Ravi sessions, but it is prompt-shaped and lacks Agent Card
  discovery, protocol negotiation, remote task state, push/stream handling, and
  external security semantics.
- Store remote agents in the existing `agents` table. That table configures
  local runtime execution and provider state; remote A2A peers need different
  lifecycle, trust, cache, credential, and health fields.
- Treat A2A as another runtime provider. Providers execute local turns and emit
  Ravi runtime events; A2A is a network delegation protocol to another agentic
  system.
- Let remote Agent Cards directly configure local authorization. Cards are
  remote claims and discovery metadata; local Ravi policy must decide which
  caller can use which remote skill and credential.
