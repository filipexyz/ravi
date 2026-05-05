---
id: self
title: "Ravi Self"
kind: domain
domain: self
capabilities:
  - agent-self-context
  - current-runtime-orientation
  - omni-context-bridge
tags:
  - self
  - context
  - agents
  - sessions
  - omni
applies_to:
  - src/cli/commands/self.ts
  - src/runtime/context-registry.ts
  - src/runtime/runtime-request-context.ts
  - src/router
  - src/sessions
  - src/omni
  - src/knowledge
owners:
  - ravi-dev
status: draft
normative: true
---

# Ravi Self

## Intent

Ravi Self is the agent-facing self-orientation layer.

It lets a running agent ask "who am I, where am I, what context matters, and what can I safely do next?" without reading raw transcripts, raw Omni payloads, or unrelated database tables.

The public namespace SHOULD be:

```bash
ravi self
```

## Core Thesis

Agents need a compact mirror, not another memory store.

`ravi self` MUST compose existing Ravi-owned semantics into a bounded `self_context_packet`.

It MUST NOT become a source of truth for session, chat, contact, route, task, permission, or knowledge state.

## Boundary

Ravi Self reads and explains.

It does not execute work, mutate state, dispatch tasks, send messages, change routes, or approve permissions.

It may suggest next read commands.

It MUST NOT suggest outbound or mutating commands unless the current context explicitly has the capability and the suggestion is labeled as a suggestion, not an action.

## Source of Truth

Ravi Self MUST compose from existing domains:

- Runtime context keys for current actor, session, capabilities, and permissions.
- Sessions for runtime state, active turn, provider metadata, trace pointers, and durable history.
- Channels/chats for chat container and participant context.
- Contacts/identity graph for human/agent identity.
- Routes for why this agent/session received the message.
- Tasks/projects/workflows for active work context.
- Tags for classification.
- Knowledge for semantic thread/context packets.
- Artifacts for generated outputs and provenance.

Ravi Self MUST NOT reconstruct these concepts from raw provider ids or display names.

## Current Context Resolution

The default command behavior MUST resolve the current runtime context from `RAVI_CONTEXT_KEY` or the equivalent live Ravi context resolver.

If no current context exists, `ravi self` MUST fail clearly with a setup/context error and suggest an explicit diagnostic command.

Privileged operators MAY query another session or agent using explicit flags such as `--session` or `--agent`, but that path MUST be permission-checked and audited.

## Self Context Packet

The default output of `ravi self context` SHOULD be a compact context packet containing:

- `identity`: current agent, session key, runtime context id.
- `runtime`: provider, model, effort/thinking, active turn state, delivery source.
- `conversation`: chat, channel, instance, thread/topic, route binding.
- `actors`: requester, recent speakers, resolved contacts/agents, unresolved identities.
- `route`: route pattern, matched policy, session binding, reason.
- `work`: linked task, project, workflow, todo, or command context.
- `knowledge`: matching knowledge threads and relevant canonical context.
- `permissions`: high-level capabilities and denied/absent capabilities.
- `recent`: bounded recent messages/events/signals.
- `next_reads`: commands to inspect deeper.

The packet MUST be bounded by default.

The packet MUST distinguish absent, unknown, unavailable, and unauthorized data.

## CLI Surface

Initial commands SHOULD be:

```bash
ravi self whoami
ravi self context
ravi self chat
ravi self route
ravi self recent
ravi self permissions
ravi self knowledge
ravi self explain
```

All commands SHOULD support `--json`.

History-heavy commands MUST follow `cli/listing`.

## Agent-Friendly Output

Human output SHOULD be short, structured, and action-oriented.

It SHOULD answer:

```text
Who am I?
Where did this prompt come from?
Who is talking?
What workstream/thread is active?
What can I read or do?
What should I inspect next?
```

It SHOULD NOT dump raw JSON, full transcripts, or large metadata blocks by default.

## JSON Contract

Machine output MUST expose typed semantic fields, not only formatted strings.

Raw Omni/channel ids MAY appear under `provenance` or `debug` fields only.

JSON MUST include enough absence/authorization metadata for an agent to recover:

```json
{
  "context": {},
  "sections": {},
  "missing": [],
  "unauthorized": [],
  "nextReads": []
}
```

## Relationship to Omni

Omni remains transport/provenance.

Ravi Self MUST expose Ravi semantics first: actor, contact, platform identity, chat, session, route, policy, and capability.

Raw Omni details MAY be shown only in debug/provenance mode.

## Relationship to Knowledge

Ravi Self MAY ask Knowledge for relevant semantic threads and context packets.

Knowledge remains the semantic memory layer. Self is the current-context mirror.

If Knowledge is unavailable, Self MUST still work with runtime/session/chat/route context and clearly mark the missing knowledge section.

## Permissions and Privacy

Ravi Self MUST respect the current runtime context permissions.

It MUST NOT reveal:

- raw secrets;
- credentials;
- unrelated session history;
- private chats outside the current scope;
- full transcripts by default;
- data from another human/contact/session unless explicitly authorized.

`ravi self permissions` SHOULD summarize capability families, not dump sensitive context keys.

## Acceptance Criteria

- A running agent can call `ravi self whoami` and identify its agent id, session key, and context id.
- A WhatsApp-originated session can call `ravi self chat` and see canonical chat/actor data without raw JID as the primary model.
- A CLI/task-only session can call `ravi self context` and degrade gracefully without chat.
- An unauthorized attempt to inspect another session fails clearly.
- `ravi self recent` is bounded by default.
- `ravi self knowledge` can show linked threads without raw transcript dumping.
- All outputs include next useful read commands.
