---
id: contacts
title: Contacts
kind: domain
domain: contacts
capabilities:
  - identity-graph
  - policy
  - discovery
  - routing-context
tags:
  - contacts
  - crm
  - identity
  - routing
applies_to:
  - src/contacts.ts
  - src/cli/commands/contacts.ts
  - src/omni/consumer.ts
  - src/router
owners:
  - ravi-dev
status: draft
normative: true
---

# Contacts

## Intent

Contacts is Ravi's public CRM and relationship surface.

It must let operators and agents understand who a human, organization, or known actor is across channels without exposing raw channel identifiers as the primary mental model.

The public UX SHOULD remain `ravi contacts`.

Internally, contacts MUST be backed by an identity graph that links channel-specific platform identities to canonical contacts and agents.

Contacts participates in Ravi's channel abstraction boundary: Omni supplies raw transport identifiers, but Ravi owns the semantic identity model.

## Boundaries

- Contacts MUST be the user-facing CLI and product language for people and organizations.
- Contacts MUST NOT treat a raw phone number, WhatsApp LID, Telegram id, email, or any channel-specific id as the canonical contact.
- A canonical contact MUST represent a real-world person or organization.
- A Ravi agent MUST remain an `agent`; it may have platform identities, but it MUST NOT become a normal contact.
- A chat/group/thread MUST NOT be modeled as a person contact. It belongs to chat/conversation/session context.
- Operational policy such as approval status, opt-out, reply mode, allowed agents, tags, and notes MUST be separated from raw identity resolution.
- Identity linking MUST be auditable and reversible when the evidence is not absolute.

## Core Concepts

- `contact`: canonical CRM record for a person or organization.
- `platform_identity`: channel-specific identifier for a contact or agent.
- `contact_policy`: operational rules and preferences attached to a contact.
- `chat`: channel conversation container such as DM, group, thread, or room.
- `chat_participant`: relationship between a chat and a platform identity/contact.
- `session_participant`: relationship between a Ravi runtime session and the actors that have participated in it.
- `identity_link_event`: audit trail for link, unlink, merge, split, and auto-link decisions.

## Canonical Rule

One real person SHOULD converge to one canonical contact.

Duplicates MAY exist temporarily when identity evidence is incomplete, but duplicates are debt. Ravi MUST provide tooling to detect and merge them.

## Identity Resolution

Inbound resolution MUST follow this shape:

1. Receive raw channel identifiers from the transport adapter.
2. Store raw identifiers as provenance/debug data.
3. Normalize the channel-specific identifier.
4. Resolve `channel + instance_id + platform_user_id` to `platform_identity`.
5. Resolve `platform_identity.owner_type + owner_id` to either contact or agent.
6. Apply contact policy when the owner is a contact.
7. Apply agent/session/routing logic after identity is known.

Ravi MUST NOT infer identity from display name alone.

Ravi MAY infer identity automatically from high-confidence channel mappings such as WhatsApp phone JID to LID mappings.

Ambiguous matches SHOULD create duplicate candidates, not automatic merges.

## Product UX

The public CLI SHOULD stay centered on contacts:

```bash
ravi contacts list
ravi contacts get <contact-or-identity>
ravi contacts add <identity> --name "Name"
ravi contacts link <contact> --channel whatsapp --id "<platform-user-id>"
ravi contacts unlink <platform-identity-id>
ravi contacts merge <source-contact> <target-contact>
ravi contacts duplicates
```

An internal `identity` service/module MAY exist, but the user-facing command SHOULD remain `ravi contacts` unless a future need appears.

## Integration Points

- `omni` is the source of raw transport events, channel identities, LID mappings, platform user ids, display names, avatars, and chat participants.
- Ravi MUST abstract Omni behind normalized contacts/chats/sessions/actors for product and agent-facing code.
- Raw Omni/channel ids MUST remain available for provenance, debugging, replay, and transport-level repair.
- `contacts` owns canonical CRM/person records and policy.
- `agents` owns Ravi agents.
- `sessions` owns runtime continuity and conversation state. A session MAY store a primary contact for DM convenience, but MUST NOT be the source of identity truth.
- `session_participants`, message metadata, and session events SHOULD carry actor identity for each participant/message because multiple contacts can interact in the same session.
- `routes` may use contact or platform identity information, but routes MUST NOT replace identity resolution.
- `events` and traces SHOULD carry contact/agent/platform identity metadata when available.

## Known Failure Modes

- Treating WhatsApp phone and WhatsApp LID as separate people forever.
- Treating a group chat as a contact/person.
- Treating an agent channel account as a human contact.
- Merging two people because they share a display name.
- Encoding approval, routing, and identity in the same table without clear semantics.
- Reconstructing identity from sessions instead of durable channel identity records.
