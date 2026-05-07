---
id: contacts/timeline
title: Contact Timeline
kind: capability
domain: contacts
capability: timeline
tags:
  - contacts
  - timeline
  - context
  - metadata
  - agents
applies_to:
  - src/contacts.ts
  - src/cli/commands/contacts.ts
  - src/omni/consumer.ts
  - src/router
  - src/session-trace
  - src/triggers
owners:
  - ravi-dev
status: draft
normative: true
---

# Contact Timeline

## Intent

The contact timeline is Ravi's durable history of what is known, changed, observed, or proposed about a contact over time.

It must let Ravi and agents understand a person or organization across channels without making sessions, chats, or raw Omni identifiers the source of truth.

The public product language remains `contacts`; the timeline is a contact capability, not a separate top-level identity product.

## Boundaries

- Timeline events MUST be attached to a canonical `contact_id` when the actor has resolved to a contact.
- Timeline events MAY reference `platform_identity_id`, `chat_id`, `session_key`, `message_id`, tasks, artifacts, calls, or external ids as provenance.
- Timeline events MUST NOT use raw Omni ids as the primary target. Raw ids belong in provenance/evidence.
- Timeline events MUST NOT replace `platform_identities`, `contact_policies`, `chat_participants`, or `session_participants`.
- Timeline events MUST NOT infer identity from display name alone.
- Timeline events MUST distinguish confirmed state changes from low-confidence agent proposals.
- Group-specific labels MUST NOT become global contact tags. They belong to `chat_participants.metadata_json` or a participant annotation model.
- Contextual status, tags, metadata, notes, and agent observations MUST carry an explicit scope when they are not globally true about the contact.

## Core Model

Ravi SHOULD maintain an append-only `contact_events` ledger.

Suggested fields:

- `id`
- `contact_id`
- `event_type`
- `scope_type`: `global`, `domain`, `project`, `chat`, `session`, `org`, `agent`, `task`, or future scope
- `scope_id`
- `source`: `manual`, `cli`, `api`, `omni`, `agent`, `migration`, or future source
- `actor_type`: `user`, `agent`, `system`, `contact`, or `unknown`
- `actor_id`
- `platform_identity_id`
- `chat_id`
- `session_key`
- `message_id`
- `task_id`
- `artifact_id`
- `confidence`
- `payload_json`
- `evidence_json`
- `created_at`
- `effective_at`

The table MAY include implementation-specific columns, but every event MUST be able to answer:

- which contact this is about
- which scope the event applies to
- what happened
- who or what caused it
- where the evidence came from
- whether it is confirmed or only proposed
- when it happened

Scope rules:

- default is `global` when no bounded scope is required
- events tied to a bounded context MUST set both `scope_type` and `scope_id`
- group-specific context, campaign context, session context, or project context must be explicit in scope to avoid leaking facts across contexts

Scope examples:

| Scope type | Meaning | Example `scope_id` |
| --- | --- | --- |
| `global` | durable fact about the contact | `NULL` |
| `domain` | business/product domain | `crm`, `support`, `personal` |
| `project` | project-specific role/context | `ravi-web`, `sampaio-crm` |
| `chat` | chat/group/thread participant context | canonical chat id |
| `session` | runtime/session observation | session key |
| `org` | relationship within an organization | org contact id |
| `agent` | agent-specific memory/profile | agent id |
| `task` | task-specific context | task id |

## Event Families

Event types SHOULD be namespaced.

Identity events:

- `identity.linked`
- `identity.unlinked`
- `identity.merged`
- `identity.candidate`

Policy events:

- `policy.status_changed`
- `policy.reply_mode_changed`
- `policy.opt_out_changed`
- `policy.allowed_agents_changed`

Profile events:

- `profile.name_changed`
- `profile.email_changed`
- `profile.avatar_changed`
- `profile.metadata_set`
- `profile.metadata_removed`
- `profile.tag_added`
- `profile.tag_removed`
- `profile.note_added`

Interaction/context events:

- `interaction.message_observed`
- `interaction.session_observed`
- `interaction.call_observed`
- `context.summary_updated`
- `context.fact_proposed`
- `context.fact_confirmed`
- `context.fact_rejected`

Implementations MAY add domain-specific event types, but they SHOULD keep the family prefix stable.

When adding a scoped event, include a clear `scope_type` and the corresponding `scope_id`. Global context should be reserved for stable facts such as canonical profile fields, confirmed identities, and durable preferences.

## Current State Versus History

The contact timeline is history. Current state remains queryable through materialized/current surfaces:

- `contacts` for canonical profile fields
- `platform_identities` for channel identities
- `contact_policies` for operational permissions/preferences
- canonical tag bindings for current tags
- metadata JSON or future typed metadata tables for current profile/context fields

State-changing commands SHOULD write both:

1. the current state mutation
2. the corresponding timeline event

If only one can be written, the mutation MUST fail or be retried transactionally. Ravi SHOULD NOT silently mutate contact state without timeline provenance once this capability is implemented.

## Status, Tags, And Metadata

`contact_policies.status` is operational approval state only:

- `allowed`
- `pending`
- `blocked`
- `discovered`

Relationship or lifecycle status such as `lead`, `customer`, `family`, `vip`, `partner`, or `needs_followup` MUST NOT be encoded in `contact_policies.status`.

Use tags or namespaced metadata instead:

- tags for coarse segmentation and filtering
- metadata for structured attributes
- notes/events for narrative or evidence-rich observations

Metadata keys SHOULD be namespaced and scoped when they are not universal, for example:

- `crm.lifecycle`
- `support.tier`
- `personal.preferences`
- `context.summary`

Examples:

```json
{
  "scope_type": "domain",
  "scope_id": "crm",
  "key": "crm.lifecycle",
  "value": "lead"
}
```

```json
{
  "scope_type": "project",
  "scope_id": "ravi-web",
  "key": "project.role",
  "value": "stakeholder"
}
```

```json
{
  "scope_type": "chat",
  "scope_id": "chat_...",
  "key": "group.role",
  "value": "admin"
}
```

Agent-generated metadata SHOULD identify the producing agent and confidence in the timeline event.

## Agent Subscriptions

Agents SHOULD listen to normalized contact events instead of raw chat/session streams when the job is "track this person across scenarios".

Recommended event topics:

```text
ravi.contacts.events.<event_type>
ravi.contacts.<contact_id>.events.<event_type>
```

The event payload MUST include at least:

- `event_id`
- `event_type`
- `contact_id`
- `source`
- `scope_type`
- `scope_id`
- `actor_type`
- `actor_id`
- `confidence`
- `payload`
- `evidence`
- `created_at`

When available, payloads SHOULD also include:

- `platform_identity_id`
- `chat_id`
- `session_key`
- `message_id`
- `task_id`
- `artifact_id`

When available, payloads SHOULD include:

- `scope_name` (human-friendly label)
- `effective_at`

Agents MAY produce `context.fact_proposed`, `context.summary_updated`, or `profile.note_added` events.

Agents MUST NOT automatically merge identities or overwrite confirmed profile data from weak evidence. Weak evidence must create proposals/candidates for review.

## Per-Contact Context Agents

Ravi MAY run agents that specialize in one contact's context, but that SHOULD be implemented as a subscription/profile over contact events rather than by hard-coding one runtime agent per person.

A "Rafa context refiner" should be modeled as:

- a trigger/subscription filtered by `contact_id`
- an agent session with explicit permission to read that contact's timeline
- outputs as proposed facts, summaries, or notes
- optional approval rules for committing proposed facts

This keeps the identity model central while allowing future personalized context workflows.

## Merge, Unlink, And History

Contact merge MUST preserve timeline history.

After merging contact A into contact B:

- new queries for B SHOULD include A's historical events
- events SHOULD preserve their original `contact_id` or store source/target merge metadata
- the merge event MUST record source contact, target contact, actor, reason, and moved identities
- merge events can preserve scope by keeping original scope with explicit scope metadata retained

Unlinking a platform identity MUST write a timeline/audit event when the identity belonged to a contact.

Deleting a contact SHOULD preserve enough tombstone or audit metadata to explain what happened to timeline entries.

## Privacy And Permissions

Contact timelines can contain sensitive personal context.

Reads SHOULD respect existing contact permissions such as `read_contact`, `read_own_contacts`, `read_tagged_contacts`, or successor policies.

Writes SHOULD require `write_contacts` or a narrower future permission.

Subscriptions MUST be scoped by contact, tag, ownership, or explicit permission. An agent must not gain access to every contact timeline merely because it can subscribe to NATS.

Timeline payloads SHOULD support redaction or minimized projections for broad events.

## CLI And API Contract

The public CLI SHOULD remain under `ravi contacts`.

Suggested commands:

```bash
ravi contacts timeline <contact> [--limit <n>] [--json]
ravi contacts note <contact> <text> [--source <source>] [--json]
ravi contacts metadata set <contact> <key> <json-value> [--json]
ravi contacts metadata remove <contact> <key> [--json]
ravi contacts metadata set <contact> <key> <json-value> --scope <type:id> [--json]
```

Existing commands such as `tag`, `untag`, `set`, `link`, `unlink`, and `merge` SHOULD emit timeline events when implemented.

API responses SHOULD expose typed objects, not formatting-only strings.

## Acceptance Criteria

- Contact tags, metadata, notes, policy changes, and identity changes produce contact timeline events.
- Timeline entries reference canonical `contact_id` and normalized actor metadata where available.
- Raw Omni/channel identifiers appear only as provenance/evidence, not as the primary contact target.
- Timeline entries preserve `scope_type` and `scope_id`; non-global context is not flattened into global contact state.
- Scoped entries (`scope_type` + `scope_id`) must be filtered consistently when an agent/session is subscribed to a limited context.
- Agent-generated context is stored as proposed or attributed context, not silent confirmed truth.
- Per-contact agents can subscribe to one contact's events without parsing every chat/session.
- A contact merge preserves historical events and makes merged history discoverable from the target contact.
- Permissions prevent unrelated agents from reading every contact timeline by default.
