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

The default command behavior MUST first use the resolved CLI context. That may
come from a runtime context key, the default credential, or tool/gateway
binding. A direct `RAVI_CONTEXT_KEY` lookup is the final fallback.

If no current context exists, `ravi self` MUST fail with the public typed
`SELF_CONTEXT_REQUIRED` error and suggest `ravi context whoami --json`.

Cross-session or cross-agent lookup is not part of this read-only slice. If a
future version adds explicit `--session` or `--agent` selectors, that path MUST
be permission-checked and audited before it can ship.

## Self Context Packet

The default output of `ravi self context` SHOULD be a compact context packet containing:

- `identity`: current agent, session key, runtime context id.
- `environment`: env names, precedence and trust semantics; never env values.
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
Every public operation MUST have a concrete return schema discoverable through
`ravi sdk returns show self.<command> --json`.

Raw Omni/channel ids MAY appear under `provenance` or `debug` fields only.

JSON MUST include enough typed section status and recovery guidance for an
agent to recover. The current packet shape is:

```json
{
  "generatedAt": 0,
  "depth": "normal",
  "limit": 10,
  "identity": {},
  "environment": {},
  "actor": { "status": "missing", "reason": "..." },
  "session": { "status": "missing", "reason": "..." },
  "chat": { "status": "missing", "reason": "..." },
  "route": { "status": "missing", "reason": "..." },
  "recent": { "status": "missing", "reason": "..." },
  "permissions": { "status": "ok", "data": {} },
  "knowledge": { "status": "unavailable", "reason": "..." },
  "explain": [],
  "nextReads": []
}
```

Authorization failures belong to the public error envelope. Optional data
absence belongs to the affected section's `status` and `reason`; callers MUST
NOT infer either condition from an omitted key.

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
- Root help, `self whoami/permissions` and `context whoami/capabilities` agree
  on facts read from the same registered context.
- A WhatsApp-originated session can call `ravi self chat` and see canonical chat/actor data without raw JID as the primary model.
- A CLI/task-only session can call `ravi self context` and degrade gracefully without chat.
- No current command accepts a cross-session or cross-agent selector.
- `ravi self recent` is bounded by default.
- `ravi self knowledge` can show linked threads without raw transcript dumping.
- All outputs include next useful read commands.
- Unknown `self context --fields` values fail with `USAGE_ERROR` and
  `acceptedFields`; invalid depth/limit preserve their public cause.
- Environment-derived actors are `partial` and `unverified`.
- All eight operations remain read-only and context resolution never touches
  `lastUsedAt`.

## Security addendum: no trust by transport

An inline context supplied by a local tool or gateway is never authoritative
by itself. SELF MUST confirm the context key against the trusted registry by a
read-only, no-touch lookup and MUST reject unknown, expired, revoked or
materially different records before returning identity, capabilities or
operational data.

For every related record that exists, the context agent, session owner, chat
binding owner, chat owner, route owner and runtime provider MUST agree. A
cross-agent session or any other contradiction is a typed failure, not a
degraded success, and its response MUST NOT reveal the foreign working
directory or record contents. This rule applies to CLI, local tool and gateway
execution paths.
