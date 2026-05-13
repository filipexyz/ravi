---
id: threads
title: "Threads"
kind: domain
domain: threads
capabilities:
  - session-handoff
  - entries
  - links
  - continuity
tags:
  - threads
  - sessions
  - chats
  - contacts
  - continuity
applies_to:
  - src/threads
  - src/cli/commands/threads.ts
  - src/cli/commands/sessions.ts
  - src/runtime/runtime-request-builder.ts
  - src/router
  - src/db.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Threads

## Intent

Threads are lightweight, portable conversation contexts.

A thread is a living subject that can exist before any agent is involved, move between agents, reference chats and contacts, and preserve enough context for the next agent or operator to continue without reconstructing the whole conversation manually.

The product language SHOULD be simple: "thread" means "fio de assunto".

## Boundary

Threads are not Knowledge.

Knowledge is curated, canonical, and optimized for durable memory. A thread is operational context: notes, questions, answers, links, handoffs, and source references that keep work moving.

Threads are not sessions.

A session is a live runtime container for one agent. A thread can be sent to many sessions over time.

Threads are not chats.

A chat is a channel conversation container such as a WhatsApp DM, group, Slack thread, Discord thread, Telegram chat, or email conversation. A thread can link to many chats, but MUST NOT become the chat identity.

Threads are not contacts.

A contact is a real person or organization. A thread can involve contacts, but MUST NOT represent a person.

Threads are not provider-native threads.

Claude, Codex, Pi, Slack, Discord, and other systems may expose their own thread ids. Those ids are materialization or provenance only. Ravi thread identity MUST be Ravi-owned.

## Definitions

- `thread`: Ravi-owned portable subject context.
- `thread_entry`: one operator note, prompt, answer, decision, observation, or source reference attached to a thread.
- `thread_link`: relationship from a thread to a contact, chat, session, agent, artifact, task, project, route, tag, or external source.
- `thread_handoff`: event recording that a thread was sent to a session or agent.
- `thread_brief`: generated context package injected into an agent prompt when a thread is used.
- `thread_target`: explicit contact/chat/session/agent selected for actions related to a thread.

## Invariants

- A thread MUST have a stable Ravi id independent of title, slug, chat id, session key, contact id, or provider-native thread id.
- Thread slugs SHOULD be human-readable, lowercase, and stable enough for CLI use, but slug changes MUST NOT change identity.
- A thread MAY exist without an agent, chat, contact, or session.
- A thread MAY link to multiple sessions and multiple chats.
- A thread MAY involve multiple contacts and agents.
- Thread links MUST use Ravi semantic ids when available: `contact_id`, `chat_id`, `session_key`, `agent_id`, `artifact_id`, `task_id`, `project_id`, or route id.
- Raw channel/provider ids MAY be stored as provenance, but MUST NOT be the primary thread model.
- Thread entries MUST be append-only by default. Edits SHOULD create a new revision or event instead of overwriting historical meaning silently.
- Thread operations that send messages, expose contact context, or include private chat history MUST pass through existing Ravi permission and policy checks.
- Sending a thread to an agent MUST inject a bounded thread brief, not an unbounded dump of all entries and source transcripts.
- Thread entries MUST preserve actor metadata when available: `actor_type`, `contact_id`, `agent_id`, `platform_identity_id`, `chat_id`, `session_key`, and raw provenance.
- A thread MUST NOT grant an agent permission to message a contact merely because that contact is linked. Outbound target selection remains explicit and audited.
- Knowledge MAY ingest from a thread later, but Knowledge MUST NOT be required for thread creation, handoff, listing, or continuation.

## Product Model

The default mental model is:

```text
thread
  -> entries[]
  -> links[]
  -> handoffs[]
  -> current brief/projection
```

Example:

```text
thread: rafa-pricing
  title: "Dúvidas com Rafa sobre pricing"
  links:
    - contact: Rafa as participant
    - chat: WhatsApp DM with Rafa as default-outbound
    - session: dev as worker
  entries:
    - operator note: "Validar modelo enterprise primeiro"
    - outbound prompt to Rafa
    - inbound answer from Rafa
    - agent summary from dev
```

## Data Model

The exact storage can evolve, but the target shape SHOULD include these concepts.

### `threads`

Fields:

- `id`
- `slug`
- `title`
- `summary`
- `status`: `open`, `waiting`, `active`, `blocked`, `closed`, or `archived`
- `owner_type`: `user`, `agent`, `system`, or future owner
- `owner_id`
- `scope_type`: `global`, `project`, `contact`, `chat`, `session`, `task`, `artifact`, `tag`, or future scope
- `scope_id`
- `default_agent_id`
- `default_chat_id`
- `default_contact_id`
- `metadata_json`
- `created_at`
- `updated_at`
- `last_entry_at`
- `last_handoff_at`

Constraints:

- `id` MUST be immutable.
- `slug` SHOULD be unique within the owner or workspace scope.
- `status` changes MUST append a thread event.

### `thread_entries`

Fields:

- `id`
- `thread_id`
- `kind`: `note`, `prompt`, `answer`, `decision`, `summary`, `source_ref`, `handoff_note`, `system`, or future kind
- `body`
- `body_format`: `text`, `markdown`, `json`, or future format
- `actor_type`: `user`, `contact`, `agent`, `system`, or `unknown`
- `actor_id`
- `contact_id`
- `agent_id`
- `platform_identity_id`
- `chat_id`
- `session_key`
- `source_type`: `message`, `session`, `artifact`, `task`, `file`, `url`, `manual`, or future source
- `source_id`
- `source_provenance_json`
- `metadata_json`
- `created_at`

Entries SHOULD store concise operational text. Large source bodies SHOULD be referenced, not copied, unless the source has no durable canonical store.

### `thread_links`

Fields:

- `id`
- `thread_id`
- `target_type`: `contact`, `chat`, `session`, `agent`, `artifact`, `task`, `project`, `route`, `tag`, `url`, `file`, or future target
- `target_id`
- `role`: `participant`, `default-outbound`, `worker`, `watcher`, `source`, `result`, `context`, `blocked-by`, or future role
- `label`
- `metadata_json`
- `created_at`
- `updated_at`

The same target MAY be linked more than once only when role or metadata makes the relationship meaningfully different.

### `thread_handoffs`

Fields:

- `id`
- `thread_id`
- `target_session_key`
- `target_agent_id`
- `origin_session_key`
- `origin_actor_type`
- `origin_actor_id`
- `prompt`
- `brief_entry_ids_json`
- `brief_source_refs_json`
- `delivery_barrier`
- `status`: `queued`, `delivered`, `failed`, or `cancelled`
- `created_at`
- `delivered_at`
- `metadata_json`

Handoffs MUST be audit events. They explain when a thread was sent to a runtime, what prompt was sent with it, and which entries/sources were included in the brief.

## CLI Surface

The CLI SHOULD keep thread operations direct and low ceremony:

```bash
ravi threads create <slug> --title "..."
ravi threads list [--status open] [--scope project:<id>]
ravi threads show <thread>
ravi threads note <thread> "..."
ravi threads link <thread> contact:<id> --role participant
ravi threads link <thread> chat:<id> --role default-outbound
ravi threads entries <thread>
ravi threads close <thread>
```

Thread handoff SHOULD integrate with sessions:

```bash
ravi sessions send <session> --thread <thread> "continua daqui"
```

The thread-specific command MAY exist as a convenience:

```bash
ravi threads send <thread> --to-session <session> "continua daqui"
```

But `ravi sessions send --thread` is the primary continuity UX because it keeps the target runtime explicit.

## Brief Contract

When a thread is sent to an agent, Ravi SHOULD build a compact thread brief containing:

- thread id, slug, title, and status;
- current summary or latest summary entry;
- linked contacts/chats/sessions relevant to the target;
- latest important entries, bounded by count and token budget;
- open questions and blocked items when explicitly recorded;
- source references with ids, not raw private transcripts by default;
- explicit outbound target hints, if configured;
- warnings about permissions, unknown actors, or missing links.

The brief MUST be distinguishable from user-authored prompt text.

Tools and permissions MUST receive structured thread context out of band. They MUST NOT parse only the human-readable brief to decide authorization.

## Thread To Chat/Contact Flow

A thread can help ask a person a question, but target resolution MUST be explicit.

Safe flow:

```text
operator creates or opens thread
  -> links contact Rafa
  -> links DM chat with Rafa as default-outbound
  -> sends thread to agent
  -> agent proposes or sends question using the explicit chat/contact target
  -> inbound answer is attached back as a thread entry/source reference
```

If a thread has multiple participant contacts or multiple outbound chats, Ravi MUST require explicit target selection before sending outbound content.

## Lifecycle

Allowed baseline statuses:

- `open`: thread exists and can receive entries.
- `active`: thread is currently being worked.
- `waiting`: waiting for a person, agent, task, or external signal.
- `blocked`: cannot continue without a required input or fix.
- `closed`: resolved but retained.
- `archived`: hidden from normal active views but retained.

Status changes MUST append a thread event or entry.

## Acceptance Criteria

- A thread can be created without creating a session.
- A thread can be linked to a contact and a chat without becoming either one.
- A thread can be sent to an existing session with `ravi sessions send --thread`.
- The target agent receives a bounded thread brief and the operator prompt in one delivery.
- The same thread can later be sent to another session and preserve continuity.
- Thread handoff does not bypass session REBAC, contact policy, or outbound target policy.
- Thread entries preserve enough actor/source provenance to audit where context came from.

## Known Failure Modes

- Treating thread as another name for Knowledge and making simple continuation too heavy.
- Treating thread as a session and losing portability across agents.
- Treating thread as a chat and tying it to one transport conversation.
- Treating linked contacts as implicit permission to message them.
- Injecting the full thread history into every prompt and leaking private or irrelevant context.
- Depending on provider-native thread ids for Ravi continuity.
- Creating duplicate thread concepts under `knowledge`, `runtime`, and `channels` without a clear boundary.
