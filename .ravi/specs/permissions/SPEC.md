---
id: permissions
title: "Permissions"
kind: domain
domain: permissions
capabilities:
  - rebac
  - delegation
  - runtime-context
  - least-privilege
tags:
  - permissions
  - rebac
  - runtime
  - security
applies_to:
  - src/permissions
  - src/runtime
  - src/contacts.ts
  - src/omni/consumer.ts
  - src/router/router-db.ts
owners:
  - ravi-rebac
  - ravi-dev
status: active
normative: true
---

# Permissions

## Intent

Ravi permissions define who can cause Ravi to read, execute, mutate, deliver, or disclose state.

The permission model MUST protect every authority-bearing surface: SDK tools, CLI groups, executables, sessions, contacts, chats, contexts, automations, observers, triggers, cron jobs, providers, and external gateways.

## Invariants

- Ravi MUST fail closed when the effective principal, object, relation, or context cannot be resolved.
- Permission checks MUST use canonical Ravi subjects and objects, not raw provider ids, display names, phone numbers, or chat titles.
- Contacts, agents, chats, sessions, automations, observers, roles, and system actors are distinct principals. A grant to one MUST NOT imply a grant to another unless an explicit relation says so.
- Groups/chats/threads are communication surfaces, not human users. They MAY constrain authority, but they MUST NOT replace the current actor principal.
- `contact_policies` status controls operational intake and reply eligibility. It MUST NOT be treated as tool/executable/CLI authorization by itself.
- Any policy that affects tool, executable, CLI, session, contact, or gateway authority MUST be represented in the permission graph or in a runtime capability context derived from that graph.
- Runtime contexts MUST carry enough structured authority provenance to explain why a tool was allowed or denied.
- Runtime providers MUST be adapters. They MUST NOT create a provider-private permission model that can bypass Ravi REBAC.

## Subject Types

The permission graph MAY contain multiple subject types. These are the canonical meanings:

- `agent`: Ravi agent identity and maximum technical authority.
- `contact`: canonical human or organization from `chat.db.contacts`.
- `platform_identity`: channel-specific identity linked to a contact or agent.
- `chat`: canonical communication surface from `ravi.db.chats`.
- `session`: runtime session.
- `role`: reusable authority bundle, similar to a Discord role.
- `automation`: cron, trigger, observer, workflow, or daemon-originated actor.
- `system`: break-glass or platform-owned actor.

## Authority Rule

External user-initiated execution MUST be authorized by the actor who caused the turn, the chat/surface where it happened, and the agent that will execute it.

Agent permission is a ceiling, not sufficient authority.

