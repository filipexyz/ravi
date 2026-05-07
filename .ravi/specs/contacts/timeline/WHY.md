# Why Contact Timeline

## Decision

Add a contact timeline capability under `contacts`.

Do not create a separate public "people" or "identity timeline" product for the MVP.

## Rationale

Ravi already has the right semantic split:

- `contact` is the person or organization.
- `platform_identity` is how that actor appears on a channel.
- `chat` is where conversation happens.
- `session` is agent runtime state.
- `contact_policy` is operational permission.

What is missing is a durable history of how contact context changes over time.

Without a timeline, tags, metadata, notes, and status changes become silent overwrites. Agents can read the current state, but they cannot tell why it changed, who changed it, or whether a piece of context came from a confirmed operator action or a weak model inference.

## Why Not One Agent Per Person First

A per-person context agent can be useful, but it should be a consumer of normalized contact events.

Starting with one runtime agent per contact would couple the feature to sessions and routing before the data model is stable. It would also make cross-channel identity harder, because each agent would have to reconstruct identity from chats and messages.

The safer sequence is:

1. normalize identity into contacts/platform identities
2. emit contact timeline events
3. let agents subscribe to contact-scoped events
4. decide later whether specific contacts deserve long-running dedicated agents

## Why Current State Is Not Enough

Current fields are optimized for lookup:

- current tags
- current metadata
- current policy
- current display name

They are not enough for audit, trust, review, or context refinement.

The timeline makes context explainable and lets agents propose improvements without immediately overwriting confirmed data.

## Why Scope Is Required

A contact can have several valid statuses at the same time:

- `allowed` operationally
- `lead` in CRM
- `premium` in support
- `stakeholder` in a project
- `admin` in one WhatsApp group
- `friend` in a personal context

Putting those into one global `status` field would make the model contradictory.

The timeline therefore separates operational status from scoped context. Global context is only for durable facts about the contact. Domain, project, chat, session, org, task, and agent context must carry `scope_type` and `scope_id`.

## Tradeoff

An append-only timeline adds storage and implementation work, but it removes ambiguity from contact context. The current state can stay fast while the event log carries history, provenance, and confidence.
