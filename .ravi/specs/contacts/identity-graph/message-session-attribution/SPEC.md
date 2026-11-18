---
id: contacts/identity-graph/message-session-attribution
title: Message And Session Identity Attribution
kind: feature
domain: contacts
capability: identity-graph
feature: message-session-attribution
tags:
  - contacts
  - identity-graph
  - messages
  - sessions
  - actors
applies_to:
  - src/omni/consumer.ts
  - src/gateway.ts
  - src/router
  - src/session-trace
  - src/triggers
  - src/runtime/human-request.ts
  - src/runtime/thread-requester.ts
  - src/runtime/delegated-requester.ts
  - src/runtime/runtime-request-context.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Message And Session Identity Attribution

## Intent

Ravi MUST associate messages, session events, and runtime sessions with identities whenever feasible.

Identity attribution connects transport events to canonical Ravi actors without making raw provider ids, chats, or sessions the source of truth.

The target shape is:

```text
message/event
  -> actor metadata
  -> platform_identity
  -> contact | agent

session
  -> chat
  -> session_participant[]
  -> platform_identity
  -> contact | agent
```

## Boundaries

- A raw channel id MUST be stored as provenance, not treated as product identity.
- A chat, group, room, thread, or DM MUST be modeled as a `chat`, not as a `contact`.
- A Ravi session MUST be treated as an agent runtime container bound to a chat. It MUST NOT be treated as a person, group, or identity source of truth.
- `chat_participants` owns canonical chat membership. `session_participants` is only the runtime subset observed by a Ravi session.
- Unknown or unresolved actors are allowed, but they MUST be explicit: `actor_type='unknown'` with raw provenance.
- Display names, profile names, avatars, and prompt text MUST NOT be sufficient evidence for automatic contact identity attribution.
- Agent-owned platform identities MUST resolve to `actor_type='agent'`, not to human contacts.

## Required Actor Metadata

Every persisted inbound/outbound message, session event, and durable runtime event SHOULD include this actor metadata when the data is known:

- `actor_type`: `contact`, `agent`, `system`, or `unknown`
- `contact_id`: set only when the actor is a resolved contact
- `agent_id`: set only when the actor is a resolved agent
- `platform_identity_id`: set when the platform sender/account identity is known
- `chat_id` or `canonical_chat_id`: canonical Ravi chat/conversation id when known
- `session_key`: Ravi runtime session key when the event belongs to a session
- `raw_sender_id`: raw provider sender id as received
- `normalized_sender_id`: normalized provider sender id used for lookup
- `source_channel`: provider/channel name such as `whatsapp`, `telegram`, `email`, or `phone`
- `source_account_id`: channel instance/account id when available
- `source_chat_id`: raw provider chat/thread/group id when available
- `source_message_id`: raw provider message id when available
- `source_thread_id`: raw provider thread id when available
- `identity_confidence`: numeric or enum confidence for the resolved identity
- `identity_provenance_json`: evidence that explains how the identity was resolved
- `observed_at` or `created_at`

Implementations MAY add storage-specific columns, but they MUST preserve enough information to reconstruct who spoke, where they spoke, and what evidence was used.

## Inbound Flow

Inbound message handling MUST resolve identity before policy, routing, and runtime side effects whenever feasible.

Expected flow:

```text
raw inbound event
  -> persist raw transport provenance
  -> normalize/upsert chat
  -> normalize sender identity
  -> resolve/upsert platform_identity when possible
  -> resolve owner contact or agent when evidence is strong enough
  -> persist message metadata with actor fields
  -> upsert chat_participant
  -> resolve route and session
  -> bind session to chat
  -> upsert session_participant
  -> persist session event with actor fields
  -> update contact interaction projections when a contact is resolved
  -> emit contact timeline event only for meaningful contact context
```

For group or shared-chat inbound messages:

- The group id MUST resolve to a chat target.
- The sender id SHOULD resolve to a participant platform identity.
- The sender actor and chat target MUST be stored separately.
- A group message MUST NOT update a contact unless the actual sender, mention target, reply target, or explicit command target resolves to that contact.

## Instance-Scoped Identity Resolution

Platform identity lookup is scoped by `channel + instance_id + normalized_platform_user_id`.
When a channel can address the same instance by more than one reference (for example a Slack
logical account slug versus a configured legacy instance UUID), resolution MUST canonicalize
those references from explicit configuration instead of relying on the exact received value.

Rules:

- The canonical instance reference and its aliases MUST be derived only from explicit
  configuration for the same instance. Another instance/workspace MUST NOT be searched.
- Resolution MUST consult the canonical reference and its configured aliases first, and MUST
  consult the exact empty legacy scope only after every scoped alias misses. The empty scope
  MUST be matched by exact equality and MUST NOT act as a wildcard.
- When equivalent aliases resolve to different owners, resolution MUST fail closed: no actor,
  reason `ambiguous_instance_alias`, and it MUST NOT pick a row by ordering.
- New platform identity writes SHOULD use the canonical instance reference when a configured
  mapping exists. Existing rows under the slug, UUID, or exact empty legacy scope MUST remain
  readable without destructive mass migration, and canonical writes/retries MUST be idempotent
  and MUST NOT create duplicate platform identities.
- `identity_provenance_json` MUST preserve the received alias, the canonical instance
  reference, the matched scope (when resolved), and a concrete reason code. `identity_not_found`
  (no platform identity resolved) MUST remain distinct from `missing_contact` (an external actor
  surface without a resolved contact principal) where both states are modeled. Unresolved and
  ambiguous actors MUST remain at zero capabilities and MUST NOT inherit agent authority.
- The alias collision check MUST take precedence over any cached chat-participant fast path.
  A participant cached from an earlier, non-conflicting resolution MUST NOT mask a later
  owner conflict across equivalent aliases; that conflict MUST still fail closed.
- Attribution and its derived authority MUST be temporally stable across consecutive turns
  and turn-context rotations. For an unchanged agent profile, a resolved actor MUST keep the
  same owner principal and non-zero agent-identity/effective capabilities on every turn, and
  an unresolved or ambiguous actor MUST stay `missing_contact` with zero capabilities.

## Outbound Flow

Outbound handling MUST distinguish the actor sending the message from the chat or contact being targeted.

Expected outbound rules:

- Ravi-originated outbound messages SHOULD persist `actor_type='agent'` and `agent_id` when an agent sends the message.
- System-originated outbound messages SHOULD persist `actor_type='system'`.
- If the sending agent has a platform account identity, the message SHOULD persist the agent-owned `platform_identity_id`.
- In a DM, the target SHOULD resolve to the contact/platform identity on the receiving side when known.
- In a group, the target is the chat. Mentioned contacts, reply targets, or explicit recipients MUST be represented separately from the chat target.
- Outbound contact interaction projections SHOULD update only when a target contact is explicitly resolved.

## Sessions

Session identity context MUST be derived from structured actor metadata, `chat_participants`, and `session_participants`.

Rules:

- A session MAY expose `primary_contact_id` only as a convenience for simple DMs.
- `primary_contact_id` MUST NOT replace per-message actor metadata.
- A session MAY contain multiple contacts, agents, systems, and unknown actors.
- `session_participants` MUST be updated from observed runtime activity, not from assumed one-human-per-session semantics.
- Tool permission checks that depend on "who is speaking" SHOULD use an explicit active actor context derived from the latest resolved actor/floor state.
- Tool permission checks MUST NOT parse raw prompt text or session names to infer identity when structured actor metadata is available.

## Human Requests Forwarded Through Bootstrap Or Relay

- A work handoff (`session.bootstrap`, or session-relay `send`, `ask`,
  `execute`) MUST retain the verified requesting contact when its trusted
  producer records the authenticated `callerContextId`. The runtime actor
  MUST be `contact:<id>`; `turnOrigin.principal` MUST still name the forwarding
  agent. Producer provenance and runtime capacity classification do not change.
- Proof MUST come from that exact persisted, host-issued `turn-runtime`
  snapshot: resolved contact actor and matching principal, agent identity
  authority, matching producing agent/session, and human inbound provenance.
  Chained work MUST trace back to the same human inbound, with bounded,
  acyclic ancestry. A CLI child, supplied actor fields, display name, requester
  card label, cached participant or session's latest speaker MUST NOT supply
  this proof. A bootstrap without it remains an agent/automation turn.
- `inform`, `answer`, `session.return`, cron, observer and other automation
  notifications MUST NOT inherit human authority from a previous request.
- Ordinary turn completion/rotation, and a turn a newer message superseded
  (`turn_context_superseded`: the person kept talking), MAY leave an admitted
  handoff usable. Any other abort, including an explicit stop or interrupt by
  the operator (`turn_context_aborted`), MUST invalidate it.
  Explicit revocation, permission-profile reduction, missing/cyclic ancestry,
  and a deleted, blocked or opted-out contact MUST invalidate human handoffs.
  Invalid human handoffs MUST receive zero capabilities, never fall back to
  the receiving agent's ambient ceiling.
- A verified handoff MUST intersect the receiving agent's capabilities and
  contact/chat policy with the producing turn's capability snapshot. It MUST
  record `humanRequest.callerContextId` and `humanRequest.originContextId` for
  audit, without exposing credential keys.
- Bases and Console access MUST use the verified requester (and the existing
  Console link/role checks). Attribution alone MUST NOT unlock personal or
  shared connectors: their direct-request/consent policy remains separate.
- Protected calls MUST revalidate the exact human ancestry and current contact
  eligibility, including calls from a live child admitted before revocation.
  Session-actor projections MUST retain the source turn's handoff restrictions.
  Normal terminal cleanup MUST NOT overwrite an explicit withdrawal with a
  benign completion reason and thereby revive queued work.
- Historical agent-only records MUST NOT be backfilled from the last human
  or a guessed requester. Missing evidence requires a fresh verified request.

## Delegated Work Keeps Its Requester (Slack Threads And Tasks)

Work a person asked for is often carried on by an agent in another session,
in turns no person started: the parent session handing a Slack thread more of
the same work from a `[System] Inform`, a report or a cron, and a task the task
runtime dispatches. Those turns MUST act in Bases (and the Console access
calls) for the person who asked, and only when that person is proven:

- **Proof is a stored pointer, re-checked on every use.** The requester is the
  `turn-runtime` context of the person's own verified request (a resolved
  contact turn of human provenance, or a verified handoff of one). It is
  re-resolved with the human-handoff rules above each time a protected call
  uses it (replayed as that turn's own agent's `execute` from its own session),
  so a withdrawal, permission reduction, blocked or opted-out contact, or
  broken ancestry refuses it again. Prompt text, a contact named in the
  prompt, display names and the session's latest speaker MUST NOT supply it.
- **Host-issued turns only.** Both rules read `turnOrigin`/`raviThread` from
  the host-issued `turn-runtime` context of the turn. A CLI child context
  carrying those fields MUST be ignored.
- **Slack thread.** A turn in the child session of an *open* Slack thread that
  is a work handoff (`session.bootstrap`, `send`, `ask`, `execute`) from an
  agent, made from a turn of the thread's own parent session by that same agent,
  inherits the thread's *first* verified human request (the earliest turn of
  that thread carrying `humanRequest`) only when that parent turn was caused by
  the thread itself: an `inform` or `answer` relayed from a turn of the
  thread's session, or the thread's `session.return` (proved by the parent
  turn's `turnOrigin` and the session of the context it names). A parent turn
  driven by another session's Ask/Inform, another thread's return, a trigger
  (a PR, an e-mail) or any other automation MUST inherit nothing.
- **Cron in the parent.** A thread handoff made from a cron run of the
  thread's own parent session (a host-issued `turn-runtime` context whose actor
  is `automation:cron:<id>` and whose `cronRunAuthority` snapshot names that
  job) acts for the cron's **owner**, never for the thread's earlier
  requester: an operator-owned cron acts as the operator, a contact-owned cron
  as that contact (refused when the contact is removed or blocked), and a cron
  with no traceable human owner inherits nothing. The run is subject to the
  same withdrawal and 72-hour rules. A person's
  own parent turn is authorized as theirs (the direct handoff above), never
  upgraded to the thread's requester. If the first request no longer resolves,
  the turn MUST NOT fall through to a later, different requester. A thread no
  person ever asked into inherits nothing.
- **Task.** `ravi tasks create` MUST record on the task (`requester_context_id`,
  written once) the verified request behind the creating turn: the turn
  itself when it is a verified human request, the thread's requester when it
  is a thread turn that inherits one, or the parent task's requester when it is
  a task turn (subtask). A dispatch turn (host-issued `raviThread` with a task
  scope) acts for that requester only while its handoff is the one the task
  runtime froze for the task's active assignment (`assigned`, `accepted`,
  `blocked`) to the same agent, and the task is not `done`, `failed` or
  archived. A task created from no verified request (a cron, an external
  contact's relay, an agent-only turn) has no requester and stays refused.
- **72-hour limit.** A delegated requester (thread or task) whose originating
  human turn is more than 72 hours old MUST NOT be inherited; the turn is
  refused again (`ACTOR_UNKNOWN`) until the person asks again.
- **Attribution only.** The inherited requester is passed as
  `delegatedRequester`; personal and shared connectors stay refused (their
  direct-request/consent policy is separate), and the agent producer stays the
  turn's actor principal for audit.
- **Not covered yet.** Turns of a task session that are not the dispatch turn
  (comment steering, resume prompts) inherit nothing; they need a fresh
  verified request.

## Interaction Projections

Contact interaction projections such as `last_inbound_at`, `last_outbound_at`, and `interaction_count` MUST only update when an actual contact actor or explicit contact target is resolved.

Rules:

- Inbound one-to-one message from a resolved contact SHOULD update `last_inbound_at` and interaction count for that contact.
- Inbound group message SHOULD update the sender contact only when the sender resolves to a contact.
- Outbound DM to a resolved contact SHOULD update `last_outbound_at` for that contact.
- Outbound group message MUST NOT update all group participants.
- Unknown actors MUST NOT create fake contacts or mutate contact projections.

## Contact Timeline Integration

`contact_events` records MAY reference messages, chats, sessions, and platform identities as provenance.

Rules:

- A contact timeline event MUST have a resolved `contact_id`.
- A timeline event MAY reference `message_id`, `chat_id`, `session_key`, `platform_identity_id`, `source_message_id`, or other provenance.
- Not every message should become a contact timeline event.
- Timeline events SHOULD be created for durable context such as confirmed facts, proposals, summaries, policy changes, meaningful interactions, or audit events.
- Timeline events derived from session/message observations MUST preserve actor metadata and scope.

## Privacy And Permissions

Identity attribution increases the sensitivity of message/session metadata.

Rules:

- Reads of message/session actor metadata MUST respect contact, chat, and session permissions.
- Broad streams or admin views SHOULD redact raw provider ids unless the caller has diagnostic permission.
- Trigger subscriptions that expose contact identity MUST apply the same authorization model as contact timeline reads.
- Unknown actor records SHOULD preserve raw provenance for diagnostics, but product surfaces SHOULD minimize it by default.

## Legacy Removal Register

These legacy or compatibility surfaces are not target architecture:

| Legacy surface | Target replacement | Removal condition |
| --- | --- | --- |
| `message_metadata.chat_id` without actor ids | message metadata with actor fields and chat target | all message reads can distinguish speaker from chat |
| `session_events.source_chat_id` only | session event actor fields plus raw provenance | session traces can show resolved actor and raw source |
| `sessions.group_id` as identity | explicit chat binding plus participants | sessions bind to canonical chats |
| `sessions.last_to` as implicit contact | explicit outbound target metadata | outbound target is represented as chat/contact/platform identity |
| `session.primary_contact_id` as truth | convenience field only | all identity-sensitive code uses actor metadata or participants |
| raw WhatsApp JID/LID in prompts as identity | structured actor metadata and provenance | tools receive active actor context |
| group-as-contact records | canonical chats and chat participants | no new group contacts are created and migrated groups have a removal path |

## Acceptance Criteria

- New inbound messages preserve resolved `contact_id`, `agent_id`, and/or `platform_identity_id` when available.
- Unknown inbound actors persist as `actor_type='unknown'` with raw provenance instead of fake contacts.
- Outbound messages preserve the Ravi agent/system actor separately from the receiving chat or contact target.
- Group messages store the chat target and sender actor separately.
- `chat_participants` represents canonical chat membership, while `session_participants` represents observed runtime participation.
- A DM session may expose `primary_contact_id`, but message actor metadata remains authoritative.
- Contact interaction projections update only for resolved contact actors or explicit contact targets.
- Contact timeline entries can link back to message/session/chat/platform provenance.
- Permission checks can use structured active actor context without parsing prompts or raw provider ids.
- Identity resolution canonicalizes configured instance aliases so a known actor stored under one instance reference (slug, UUID, or exact empty legacy scope) resolves for the same instance, without ever selecting another instance/workspace.
- Equivalent instance aliases that resolve to different owners fail closed with `ambiguous_instance_alias`, no actor, and zero capabilities, distinct from `identity_not_found`.
