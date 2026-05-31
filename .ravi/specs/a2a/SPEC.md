---
id: a2a
title: "Agent-to-Agent Interop"
kind: domain
domain: a2a
capabilities:
  - registry
  - auth
  - client
  - server
tags:
  - a2a
  - agent-to-agent
  - interoperability
  - remote-agents
applies_to:
  - .ravi/specs/a2a
  - src/a2a/
  - src/cli/commands/a2a.ts
  - src/sdk/gateway
  - src/runtime/context-registry.ts
  - src/artifacts/
owners:
  - ravi-dev
status: draft
normative: true
---

# Agent-to-Agent Interop

## Intent

Ravi A2A support lets Ravi discover, trust, call, observe, and optionally expose
agents that speak an Agent-to-Agent protocol, starting with the public
Agent2Agent (A2A) protocol.

The goal is programmatic collaboration with external agents without weakening
Ravi's ownership of sessions, permissions, traces, artifacts, credentials, and
delivery semantics.

## Definitions

- `a2a_remote_agent`: an external agentic service described by an Agent Card and
  invoked over a protocol binding such as JSON-RPC over HTTP.
- `agent_card`: public metadata describing a remote agent's provider,
  interfaces, capabilities, skills, security requirements, and protocol
  versions.
- `a2a_registry_entry`: Ravi's durable local record for one remote agent,
  including discovered card metadata, trust state, cache state, ownership, and
  invocation defaults.
- `a2a_skill`: a capability advertised by a remote Agent Card. It is searchable
  metadata for delegation and MUST NOT be confused with Ravi runtime skills,
  Codex skills, or MCP tools.
- `a2a_task`: a remote unit of work with a remote task id, context id, status,
  messages, and artifacts.
- `a2a_invocation`: one Ravi-authored call to a remote agent, correlated to the
  caller context, optional Ravi thread, remote task id, artifacts, and audit.
- `a2a_auth_binding`: Ravi's durable mapping between a local caller policy, a
  remote Agent Card security scheme, a credential reference, scopes, and an
  authorization mode such as service-account or on-behalf-of.

## Boundary

A2A owns:

- remote agent discovery and registry state;
- remote Agent Card validation, caching, refresh, and trust metadata;
- outbound calls to remote A2A agents;
- A2A authorization policy, credential binding, and invocation audit;
- inbound A2A server endpoints when Ravi exposes selected local agents;
- correlation between Ravi contexts and remote task/context ids;
- conversion between A2A messages/artifacts and Ravi messages/artifacts.

A2A does NOT own:

- local Ravi `agents` rows, provider selection, or provider session state;
- local session routing, attach, speech, or channel delivery;
- Omni transport behavior;
- MCP tool definitions or dynamic tool execution;
- credential storage primitives;
- task runtime scheduling except through explicit bridge points.

## Invariants

- Ravi local agents MUST remain in the `agents` domain. Remote A2A agents MUST
  have their own registry table/model and MUST NOT be inserted into `agents`
  unless the operator explicitly creates a local wrapper agent.
- A2A MUST NOT be modeled as a runtime provider. A runtime provider executes a
  local Ravi session; A2A delegates work to an independent peer over a network
  protocol.
- A2A and MCP MUST remain separate concepts. A2A is peer delegation between
  agents; MCP is tool/resource access inside an agent.
- All A2A calls MUST go through a Ravi-owned client service that enforces
  permission, credential resolution, timeout policy, audit, and trace
  correlation. Runtime prompts MUST NOT perform arbitrary HTTP calls to Agent
  Card endpoints or task endpoints directly.
- A2A authorization MUST be explicit Ravi policy. Agent Card `securitySchemes`,
  `security`, and skill-level requirements advertise how to authenticate, but
  they MUST NOT by themselves grant a local agent/session permission to call the
  remote agent.
- Every outbound invocation MUST pass both checks: the local caller is
  authorized to invoke the remote agent/skill, and Ravi can resolve an enabled
  credential binding compatible with the selected remote security requirement.
- Agent Card discovery MUST support the current well-known path
  `/.well-known/agent-card.json`. Legacy discovery paths MAY be supported only
  as compatibility aliases and MUST be recorded as such.
- A2A protocol version, selected interface, protocol binding, and supported
  capabilities MUST be stored with each registry entry and each invocation.
- Credentials MUST be stored through Ravi credential infrastructure. Agent Cards,
  specs, logs, and prompt context MUST NOT contain bearer tokens, OAuth client
  secrets, API keys, or private signing keys.
- Credential references MUST be selected by registry/auth policy, never by
  model-generated prompt text. Ambient environment keys MAY be imported into the
  credential system by operator action, but runtime A2A calls MUST NOT fall back
  to raw environment variables.
- Remote async updates, push notifications, and stream chunks delivered into an
  active Ravi session MUST be queued as follow-up by default. Immediate steering
  MAY be allowed only through an explicit caller option and trace reason.
- A2A artifacts MUST be materialized as Ravi artifacts or as safe external
  references before they are injected into a session. Raw file bytes MUST NOT be
  placed directly into prompts unless the receiving runtime path explicitly
  supports that media mode.
- A2A server exposure MUST be opt-in per Ravi agent. No local agent is publicly
  advertised or callable through A2A by default.

## Implementation Shape

The first implementation SHOULD introduce:

- `src/a2a/types.ts` for protocol-neutral Ravi DTOs plus A2A v1 mapping types;
- `src/a2a/registry-db.ts` and `src/a2a/registry.ts` for durable remote agent
  records;
- `src/a2a/auth.ts` for caller authorization, credential binding, challenge
  handling, and audit metadata;
- `src/a2a/client.ts` for outbound calls, polling, streaming, cancellation, and
  task state;
- `src/a2a/server.ts` only after client/registry are stable;
- `src/cli/commands/a2a.ts` as the decorated CLI source of truth for SDK and
  gateway exposure.

## Validation

- `ravi specs get a2a --mode full --json`
- `ravi specs get a2a/registry --mode full --json`
- `ravi specs get a2a/auth --mode full --json`
- `ravi specs get a2a/client --mode full --json`
- `ravi specs get a2a/server --mode full --json`
- Future implementation: `bun test src/a2a/ src/cli/commands/a2a.test.ts`
- Future implementation: `bun run typecheck`
- Future implementation: `bun run build`

## Known Failure Modes

- Treating a remote Agent Card as a trusted permission grant instead of
  untrusted metadata.
- Treating a declared remote security scheme as authorization instead of only
  an authentication mechanism.
- Collapsing remote agents into local `agents`, which breaks runtime ownership
  and creates fake provider/session state.
- Letting an LLM choose an arbitrary URL to call, bypassing registry trust and
  audit.
- Confusing A2A skills with Ravi skills or MCP tools, causing prompt/tool
  surfaces to advertise capabilities that Ravi cannot enforce.
- Losing remote task ids or context ids, making cancellation, polling, and audit
  impossible.
- Injecting remote push updates as interruptions and cutting off active Ravi
  work instead of queueing them as follow-up.
