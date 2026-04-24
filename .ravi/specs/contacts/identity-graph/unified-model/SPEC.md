---
id: contacts/identity-graph/unified-model
title: Unified Contacts Model
kind: feature
domain: contacts
capability: identity-graph
feature: unified-model
tags:
  - contacts
  - identity-graph
  - migration
  - cli
applies_to:
  - src/contacts.ts
  - src/cli/commands/contacts.ts
  - src/omni/consumer.ts
  - src/router/sessions.ts
  - src/router/resolver.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Unified Contacts Model

## Intent

Unify Ravi contact identity handling in one coherent model.

The implementation should be allowed to happen in one coordinated migration rather than a long compatibility drip, as long as existing user-facing `ravi contacts` workflows keep working.

The model MUST make Ravi the semantic owner above Omni. Omni remains the transport source for raw ids and delivery facts; Ravi exposes contacts, platform identities, chats, sessions, actors, and policies.

## Target State

Ravi should expose contacts as the product surface and use an identity graph internally:

```text
contact
  -> platform_identity[] owned by contact
agent
  -> platform_identity[] owned by agent
chat
  -> chat_participant[] -> platform_identity -> contact|agent
session
  -> chat
  -> session_participant[] -> platform_identity -> contact|agent
contact_policy
  -> contact
```

## Data Model

### `contacts`

Canonical person/org record.

Fields:

- `id`
- `kind`: `person` or `org`
- `display_name`
- `primary_phone`
- `primary_email`
- `avatar_url`
- `metadata_json`
- `created_at`
- `updated_at`

### `platform_identities`

Channel-specific identifier.

Fields:

- `id`
- `owner_type`: `contact` or `agent`
- `owner_id`
- `channel`
- `instance_id`
- `platform_user_id`
- `normalized_platform_user_id`
- `platform_display_name`
- `avatar_url`
- `profile_data_json`
- `is_primary`
- `confidence`
- `linked_by`
- `link_reason`
- `first_seen_at`
- `last_seen_at`
- `created_at`
- `updated_at`

Constraints:

- `channel + instance_id + normalized_platform_user_id` MUST be unique.
- `owner_type + owner_id` MUST be present for resolved identities.
- Agent-owned identities MUST NOT be merged into contacts.

### `contact_policies`

Operational relationship state.

Fields:

- `contact_id`
- `status`: `allowed`, `pending`, `blocked`, `discovered`
- `reply_mode`: `auto` or `mention`
- `allowed_agents_json`
- `opt_out`
- `tags_json`
- `notes_json`
- `source`
- `last_inbound_at`
- `last_outbound_at`
- `interaction_count`
- `created_at`
- `updated_at`

Policy MAY be stored inline during the first implementation if that is simpler, but the code and naming MUST keep policy conceptually separate from identity resolution.

### `session_participants`

Runtime session participation.

Fields:

- `session_key`
- `owner_type`: `contact`, `agent`, or `unknown`
- `owner_id`
- `platform_identity_id`
- `role`: `human`, `agent`, `system`, `observer`, or future role
- `first_seen_at`
- `last_seen_at`
- `message_count`
- `metadata_json`

Constraints:

- A session is an agent runtime bound to a chat. It is not the chat itself.
- One chat MAY have multiple sessions, including multiple agents with separate runtime history over the same chat.
- A session MAY have many participants.
- A participant record MUST NOT imply identity ownership. It only states that an actor participated in that runtime session.
- The canonical membership list belongs to `chat_participants`; `session_participants` is scoped to runtime activity.
- DMs MAY expose a `primary_contact_id` convenience field, but message/event actor metadata remains authoritative for "who said this".

### Message And Event Actor Metadata

Inbound/outbound message metadata and session events SHOULD persist actor fields:

- `actor_type`: `contact`, `agent`, `system`, or `unknown`
- `contact_id`
- `agent_id`
- `platform_identity_id`
- `raw_sender_id`
- `normalized_sender_id`
- `identity_confidence`
- `identity_provenance`

This is required because a group, thread, or shared support session can contain multiple contacts and agents.

### `identity_link_events`

Append-only audit trail.

Fields:

- `id`
- `event_type`: `link`, `unlink`, `merge`, `split`, `auto_link`, `candidate`
- `source_owner_type`
- `source_owner_id`
- `target_owner_type`
- `target_owner_id`
- `platform_identity_id`
- `confidence`
- `reason`
- `actor_type`
- `actor_id`
- `metadata_json`
- `created_at`

## Normalization Rules

- Raw provider identifiers MUST be preserved as provenance even after normalization.
- Feature code SHOULD use normalized Ravi identity/chat/session abstractions instead of raw Omni ids.
- WhatsApp phone JID and bare phone MUST normalize to a stable phone identity.
- WhatsApp LID MUST normalize separately, but MAY auto-link to phone when a trusted LID mapping exists.
- WhatsApp group JID MUST normalize as chat/group identity, not contact identity.
- Telegram user id MUST include channel and instance scope.
- Email and phone MAY be represented as platform identities even when no chat instance exists.
- Legacy channel identities SHOULD be migrated only when the channel remains active. Dead channel integrations SHOULD be removed instead of preserved as first-class target architecture.

## Inbound Resolution

Inbound message handling MUST resolve identities before policy/routing decisions when feasible.

Expected flow:

```text
raw inbound
  -> persist raw transport provenance
  -> normalize/upsert chat
  -> normalize platform sender/chat ids
  -> upsert platform_identity
  -> upsert chat_participant
  -> link or create contact when evidence is strong enough
  -> persist/update session participant for the resolved actor
  -> apply contact policy
  -> route/session resolution
  -> persist message/session/event metadata with actor contact/platform identity ids
```

For group messages:

- The group itself MUST resolve as a chat, not contact.
- The sender participant SHOULD resolve to a contact or agent platform identity.
- Group participant metadata SHOULD populate chat participants when available.

## Ravi/Omni Boundary

Omni-facing code MAY know about:

- provider message ids
- channel-specific sender ids
- WhatsApp LID/phone/group JIDs
- Telegram ids
- provider delivery and media payloads

Ravi-facing feature code SHOULD know about:

- `contact`
- `platform_identity`
- `agent`
- `chat`
- `session`
- `session_participant`
- `actor`
- `message`
- `contact_policy`

If a feature needs to branch on a channel capability, it SHOULD ask Omni through the Ravi channel boundary instead of inspecting raw Omni ids directly. A central Ravi capability registry can wait until there is concrete need.

Channel capabilities MAY be deferred for this implementation. Omni should be the source of capability facts when Ravi needs them, but contacts/chat identity work MUST NOT be blocked by building a large capability registry.

Examples:

- Sticker support should check channel capabilities, not assume WhatsApp by JID suffix in product code.
- Calls/outbound should target contact or platform identity, then resolve a channel identity late.
- Routes may match raw ids for compatibility, but should store resolved semantic metadata when available.

## CLI Contract

`ravi contacts` MUST remain the public command surface.

Required commands:

```bash
ravi contacts list
ravi contacts get <contact-or-identity>
ravi contacts add <identity> [--name <name>] [--kind person|org]
ravi contacts link <contact> --channel <channel> --id <platform-user-id> [--instance <id>] [--reason <text>]
ravi contacts unlink <platform-identity-id> [--reason <text>]
ravi contacts merge <source-contact> <target-contact> [--reason <text>]
ravi contacts duplicates [--json]
```

Existing compatibility aliases such as `info`, `check`, and `identity-add` MAY remain, but new help text SHOULD teach the canonical commands above.

JSON output MUST expose `contact`, `platformIdentities`, `policy`, and `duplicateCandidates` as typed objects instead of formatting-only strings.

## Duplicate Handling

`duplicates` MUST find likely duplicate contacts without merging them.

Signals:

- Same primary phone or email.
- LID and phone mapping points to different contacts.
- Same platform identity present in two records, which should be impossible after constraints.
- Same normalized phone across identities.

Weak signals such as display name similarity MAY be shown as low-confidence suggestions only.

## Migration Requirements

Existing `contacts_v2` and `contact_identities` data MUST be migrated without data loss.

Migration MUST preserve:

- contact id where possible
- name/email
- status/reply_mode
- allowed agents
- opt-out
- tags/notes/source
- interaction counters
- all existing identities

Migration SHOULD map current active platforms:

- `phone` -> `platform_identities(channel='phone')`
- `whatsapp_lid` -> `platform_identities(channel='whatsapp')`
- `whatsapp_group` -> chat/group migration path, not person contact
- `telegram` -> `platform_identities(channel='telegram')`

Legacy Matrix-specific fields and identities SHOULD be removed or archived during the migration unless an active Matrix channel is reintroduced.

If a legacy contact represents a WhatsApp group, it SHOULD migrate into chat metadata or remain as a compatibility contact marked `kind='org'` only until a chat model owns it. New group contacts MUST NOT be created.

Current legacy surfaces that MUST be accounted for:

- `contacts_v2.agent_id`, `reply_mode`, `allowed_agents`, `opt_out`, `tags`, `notes`, and interaction counters map to contact policy/profile data.
- `contact_identities.platform + identity_value` maps to `platform_identities`.
- `contacts_v2.notes.groupTags` SHOULD move to `chat_participants.metadata_json` or a future participant annotation table, because group-specific contact labels belong to the relationship between actor and chat.
- `account_pending` SHOULD split pending humans from pending chats/groups instead of creating group contacts.
- `omni_group_metadata.participants_json` SHOULD seed `chat_participants`.
- `message_metadata` and `session_events` SHOULD gain actor metadata rather than storing only raw `chat_id`/source ids.
- `agents.matrix_account`, `matrix_accounts`, and other dead channel-specific fields SHOULD be removed or archived unless the channel is reactivated.

## Legacy Removal Register

These legacy surfaces are not target architecture. The implementation MUST either remove them or leave an explicit compatibility shim with a removal condition.

| Legacy surface | Target replacement | Removal condition |
| --- | --- | --- |
| `contacts_v2` table/name | `contacts` canonical table/model | migrated data validated and CLI/API reads from `contacts` |
| `contact_identities` table/name | `platform_identities` | migrated identities validated, link/unlink/merge use platform identities |
| `Contact.phone` compatibility field | primary platform identity lookup or explicit contact ref | callers no longer assume every contact has a phone-shaped id |
| `contacts_v2.agent_id` | `contact_policies` / routing policy / allowed agents | policy migration preserves behavior |
| `contacts_v2.allowed_agents` inline JSON | `contact_policies` or scoped policy relation | policy reader no longer depends on contacts row JSON |
| `contacts_v2.notes.groupTags` | `chat_participants.metadata_json` or participant annotation table | group labels available via chat participant lookup |
| `contact_identities.platform='whatsapp_group'` | `chats` and `chat_participants` | all group contacts migrated to chats |
| group records in `contacts_v2` | `chats` | no code creates or requires group-as-contact records |
| `account_pending` group semantics | pending chat/route review backed by `chats` | pending humans and pending chats are separated; chat approval creates/removes route review state without creating contacts |
| `agents.matrix_account` | active channel platform identity or removal | no active Matrix channel or replacement identity exists |
| `matrix_accounts` table | active channel account model or removal/archive | Matrix integration removed or reintroduced through channel abstraction |

Raw transport caches such as `omni_group_metadata` MAY remain after migration, but only as provider/cache provenance. They MUST NOT be the canonical participant model.

## Acceptance Criteria

- A single person with phone, WhatsApp LID, Telegram, email, and other active channel identities resolves to one contact.
- A Ravi agent with a WhatsApp, Telegram, or other active channel identity resolves as an agent-owned platform identity, not a human contact.
- A WhatsApp group does not appear as a human contact.
- A group or shared session can have multiple contact participants without overwriting session identity.
- Messages/events in multi-contact sessions preserve the actor that produced each message.
- A reply/inbound event persists resolved contact/platform identity metadata when available.
- Product/agent-facing code can operate without knowing raw Omni ids, while diagnostics can still recover the raw provider provenance.
- `ravi contacts get <any-known-id>` returns the same canonical contact for linked identities.
- `ravi contacts merge` moves identities, preserves policy data, and writes audit events.
- `ravi contacts duplicates` reports candidates without destructive changes.
