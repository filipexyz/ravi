---
id: contacts/identity-graph/inbound-contact-intake
title: Inbound Contact Intake
kind: feature
domain: contacts
capability: identity-graph
feature: inbound-contact-intake
tags:
  - contacts
  - identity-graph
  - inbound
  - chats
  - crm
  - migration
applies_to:
  - src/contacts.ts
  - src/omni/consumer.ts
  - src/router/router-db.ts
  - src/db.ts
  - src/cli/commands/contacts.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Inbound Contact Intake

## Intent

Inbound contact intake guarantees that Ravi captures the human side of inbound channel conversations as canonical contacts before analysis, CRM enrichment, or agent routing.

The goal is simple: when a new human starts a direct conversation with a Ravi-managed instance, Ravi should know who the channel actor is, how to find them again, which chat they came from, and which messages provide evidence, even if no agent is assigned yet.

This spec extends `contacts/identity-graph/unified-model` and `channels/chats`.

## Product Rule

There is one product concept named contact.

- `contacts` is the canonical person/org record.
- `platform_identities` links contacts and agents to channel identities scoped by channel and instance.
- `contact_policies` stores operational state such as `discovered`, `pending`, `allowed`, `blocked`, reply mode, tags, notes, and opt-out.
- `crm_contact_profiles` is a CRM projection for relationship work. It MUST NOT become another contact table or another contact concept.
- `chats` is the channel conversation container. A chat, group, room, or thread MUST NOT become a contact.
- Runtime contact behavior MUST read and write only the canonical model.

## Instance Configuration

Inbound contact intake MUST be configurable per channel instance.

Suggested setting:

```text
contact_intake_mode = off | discovered | pending
default_contact_tags = string[]
```

Semantics:

- `off`: Ravi stores chat/message provenance but does not auto-create contacts.
- `discovered`: Ravi auto-creates or links contacts with `contact_policies.status='discovered'`.
- `pending`: Ravi auto-creates or links contacts with `contact_policies.status='pending'`.
- `default_contact_tags`: list of canonical tag slugs that MUST be attached to any contact created for the first time through this instance's intake (runtime or backfill). Tags MUST NOT be reapplied on subsequent inbound events for the same contact.

`contact_intake_mode` MUST NOT imply permission to auto-reply. Reply permission remains governed by route, policy, pairing, allowed agents, opt-out, and runtime settings.

`default_contact_tags` MUST be expressed as canonical slugs. Implementations SHOULD trim, deduplicate, and normalize entries before storing.

The default for a CRM-enabled/business intake instance SHOULD be `discovered`. The global default MAY remain conservative until migration has been validated.

## Default Contact Tags

Default contact tags enable a fixed policy hook at the moment a canonical contact is first created. They give downstream consumers (observers, CRM workers, reading lists) a stable selector to bind to without inspecting business-specific metadata.

Rules:

- Default tags MUST apply only when intake creates a new canonical `contacts` row (`createdContact=true`). Existing contacts MUST NOT receive instance default tags retroactively.
- Backfill MUST honor the same rule: only `create_contact` actions apply default tags. `link_existing` and `already_linked` MUST NOT add or remove default tags.
- Tag application MUST persist via the canonical tag binding pipeline used by `ravi contacts tag`, producing a `canonical_tag_bindings` row and mirroring into `contact_policies.tags_json`.
- Each application MUST emit exactly one `profile.tag_added` event in `contact_events` per intake decision, carrying the tag list, instance id, and a stable `reason` identifier (e.g. `instance_default_contact_tags`).
- Default tag failures (invalid slug, unavailable tag definition) MUST NOT block contact creation. The intake transaction MUST proceed without applying that specific tag and SHOULD surface a warning.
- Operators MAY change default tags at any time. Changes MUST NOT trigger re-tagging of existing contacts. To retag, operators MUST run an explicit batch via `ravi contacts tag <id> <slug>`.

Default contact tags SHOULD be used as the bridge between intake and observer rules: an instance tags every new contact with a state slug (for example `new-contact`), and observer rules with `--scope tag --tag-target contact --tag new-contact` automatically attach observers. State transitions are then expressed by adding/removing tags on the contact.

## Inbound Flow

For every inbound channel event, Ravi SHOULD perform the semantic intake before returning due to missing route, missing agent, pairing approval, or pending chat state.

Expected flow:

```text
Omni raw inbound
  -> preserve raw transport provenance
  -> upsert canonical chat
  -> persist durable inbound message record
  -> normalize sender identity
  -> resolve or create platform_identity
  -> resolve or create canonical contact when sender is human and intake is enabled
  -> upsert chat_participant with contact/platform identity when available
  -> persist per-message actor metadata
  -> apply contact policy, route, pairing, and agent runtime decisions
  -> optionally enqueue CRM/observer analysis later
```

The contact/platform identity step MUST be independent of whether a runtime agent is assigned to the chat.

If route resolution returns "no route" or the chat goes to pending review, Ravi SHOULD still have already captured:

- canonical `chat`
- durable inbound message record
- raw and normalized sender ids
- `platform_identity` when sender identity is known
- canonical `contact` when sender is a human and intake is enabled
- `chat_participant` linking the sender to the chat

## Direct Messages

For direct messages, the remote human SHOULD be created or linked as a contact when intake is enabled.

Rules:

- The contact record MUST be canonical `contacts`.
- The channel identity MUST be represented in `platform_identities` with `channel`, `instance_id`, `platform_user_id`, and `normalized_platform_user_id`.
- WhatsApp technical ids from Omni are stored as WhatsApp identity values, not as a separate contact platform.
- The contact's operational status MUST come from instance intake mode unless an existing policy already has a stronger/manual status.
- Existing `blocked`, `allowed`, and `opt_out` values MUST NOT be reset by automatic intake.
- Display name, push name, avatar, and profile data MAY enrich the contact/platform identity, but MUST NOT be used as sole merge proof.

## Groups, Rooms, And Threads

A group, room, or thread MUST be captured as a `chat`, not as a contact.

For group messages:

- The group id resolves to `chats`.
- The sender resolves to `platform_identities` and then contact or agent when possible.
- Group participant intake MAY create contacts for human senders when instance policy enables it.
- Ravi MUST NOT create a contact whose identity is the group JID/chat id.

Group-specific labels, roles, and notes SHOULD live on `chat_participants.metadata_json` or a participant annotation model, not global contact tags.

## Durable Message Record

Inbound intake requires a durable message ledger or equivalent persistent record for channel messages.

The existing reply/media `message_metadata` cache MUST NOT be the only storage used to satisfy "the conversation is backed up" because it is TTL-oriented metadata for reply reinjection.

Session-scoped runtime history MUST NOT be the only storage used either, because chats without an assigned agent may not create a runtime session.

Chat reading lists and incremental observer/CRM review depend on this durable ledger. Implementations that add "last read" cursors for chats MUST also consult `channels/chats/reading-lists`.

A durable inbound message record SHOULD include:

- stable message id or provider external id
- canonical `chat_id`
- channel and `instance_id`
- raw provider chat id and sender id
- normalized sender id
- `actor_type`
- `contact_id` when actor is a contact
- `agent_id` when actor is an agent
- `platform_identity_id` when known
- message kind/content or a durable pointer to content/media/transcript
- raw provenance/evidence
- provider timestamp and ingest timestamp

Writes MUST be idempotent by provider message id within channel/instance/chat scope.

## Pending Semantics

Pending MUST be split by domain.

- Pending chat/route review means the conversation exists but routing or approval is not resolved.
- Pending/discovered contact review means the person exists as a contact but has not been reviewed or allowed.
- Pending CRM analysis means relationship context has not been enriched yet.

`account_pending` MAY remain during migration, but its rows MUST NOT be treated as the canonical contact list.

`contact_policies.status` MUST be the operational contact review state.

`crm_contact_profiles.lifecycle` MUST NOT be used as contact approval state.

## CRM Boundary

Inbound contact intake MUST NOT require CRM analysis.

Automatic intake MAY create no CRM profile at all, or MAY create a default `crm_contact_profiles` row with `lifecycle='unknown'` for CRM-enabled instances.

If a default CRM profile is created, it MUST be treated as an empty relationship projection, not as analysis.

Observers, enrichment jobs, or agents MAY later read discovered/pending contacts and produce CRM facts, opportunities, activities, and next actions with provenance.

## Canonical Writes

New write paths MUST be canonical-only:

1. write `contacts`
2. write `contact_policies`
3. write `platform_identities`
4. write `contact_events` and `identity_link_events`

New canonical contacts MUST remain visible to `ravi contacts` commands without a second contact store.

Code MUST NOT introduce a third "CRM contact" source of truth.

## Service Contract

Implementations SHOULD expose one service boundary for inbound intake, for example `ensureContactFromInbound`.

The service SHOULD accept:

- channel
- instance id
- platform chat id
- platform sender id
- normalized sender id
- sender display/profile data
- chat type
- source event id
- provider message id
- intake mode
- provenance/evidence

The service SHOULD return:

- `chat`
- `contact` when resolved or created
- `platformIdentity` when resolved or created
- `policy`
- `chatParticipant`
- flags for created/updated records
- emitted audit event ids

The service MUST be idempotent for repeated delivery of the same inbound event.

## Identity Evidence

Strong evidence MAY auto-link or auto-create:

- exact `channel + instance_id + normalized_platform_user_id`
- trusted WhatsApp identity mapping from Omni
- explicit operator action
- imported record with stable external id

Weak evidence MUST NOT auto-merge:

- display name
- push name
- avatar similarity
- same first name
- recent conversation proximity

Weak evidence MAY create duplicate candidates or proposed facts.

## Backfill

One-time import SHOULD run after the canonical intake service exists when old data needs to be preserved.

Source data MAY include:

- `account_pending`
- `chats`
- `chat_participants`
- `message_metadata`
- session-scoped `messages`
- session events and traces with raw channel ids

Backfill SHOULD:

- create or link canonical contacts for human DMs
- create platform identities with channel and instance scope
- preserve existing policy values
- avoid creating contacts for group chat ids
- update chat participants and message actor metadata when identities become known
- record migration provenance in contact/identity events

## Acceptance Criteria

- A new inbound human DM can produce a canonical contact without an assigned agent.
- The same inbound event can be processed twice without creating duplicate contacts or identities.
- A chat with no route still has a chat record, durable message record, and contact/platform identity when intake is enabled.
- `ravi contacts list/get` can see automatically discovered contacts.
- Pending chats, pending contacts, and pending CRM analysis are distinguishable in CLI/API output.
- A WhatsApp group id never creates a human contact.
- Existing blocked/allowed/opt-out policies survive automatic intake.
- CRM enrichment can run later without being required for contact capture.
- Raw provider ids remain available as provenance without becoming the product model.
- An instance with `default_contact_tags` applies those tags exactly once, at first canonical contact creation, with a `profile.tag_added` audit event tracking the cause.
- Repeating intake for the same contact does not re-add or remove default tags.
