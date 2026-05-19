---
id: threads
title: "Threads"
kind: domain
domain: threads
capabilities:
  - session-handoff
  - entries
  - links
  - comments
  - responsibility
  - visibility
  - observers
tags:
  - threads
  - sessions
  - chats
  - contacts
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
- `thread_comment`: a concise operator, agent, or observer comment appended to a thread as a `thread_entry`.
- `thread_link`: relationship from a thread to a contact, chat, session, agent, artifact, task, project, route, tag, or external source.
- `thread_handoff`: event recording that a thread was sent to a session or agent.
- `thread_brief`: generated context package injected into an agent prompt when a thread is used.
- `thread_target`: explicit contact/chat/session/agent selected for actions related to a thread.
- `thread_assignee`: contact, agent, user, or system currently responsible for moving the thread forward.
- `thread_watcher`: contact, agent, user, or system subscribed to thread updates without owning the work.
- `thread_observer`: future sidecar observer scoped to one thread and one source session.
- `thread_brief_snapshot`: persisted audit record of the brief projection included in a handoff.

## Invariants

- A thread MUST have a stable Ravi id independent of title, slug, chat id, session key, contact id, or provider-native thread id.
- Thread slugs SHOULD be human-readable, lowercase, and stable enough for CLI use, but slug changes MUST NOT change identity.
- A thread MAY exist without an agent, chat, contact, or session.
- A thread MAY link to multiple sessions and multiple chats.
- A chat MAY have multiple Ravi threads. A chat-scoped thread MUST remain a thread, not a chat or provider-native thread.
- A thread MAY involve multiple contacts and agents.
- Thread links MUST use Ravi semantic ids when available: `contact_id`, `chat_id`, `session_key`, `agent_id`, `artifact_id`, `task_id`, `project_id`, or route id.
- Raw channel/provider ids MAY be stored as provenance, but MUST NOT be the primary thread model.
- Thread entries MUST be append-only by default. Edits SHOULD create a new revision or event instead of overwriting historical meaning silently.
- Thread operations that send messages, expose contact context, or include private chat history MUST pass through existing Ravi permission and policy checks.
- Sending a thread to an agent MUST inject a bounded thread brief, not an unbounded dump of all entries and source transcripts.
- Thread entries MUST preserve actor metadata when available: `actor_type`, `contact_id`, `agent_id`, `platform_identity_id`, `chat_id`, `session_key`, and raw provenance.
- A thread MUST NOT grant an agent permission to message a contact merely because that contact is linked. Outbound target selection remains explicit and audited.
- Thread watcher/subscriber links MUST NOT grant read, write, handoff, or outbound permissions by themselves.
- Thread assignee is responsibility metadata. It MUST NOT replace owner, permissions, or outbound target selection.
- Thread entry/link visibility MUST be enforced when building briefs and exposing thread context to agents or tools.
- Knowledge MAY ingest from a thread later, but Knowledge MUST NOT be required for thread creation, handoff, listing, or continuation.
- `ravi sessions send --thread` MAY create a missing thread only when the send request includes the required thread creation fields. It MUST NOT create an underspecified thread silently.

## Product Model

The default mental model is:

```text
thread
  -> entries[]
  -> links[]
  -> handoffs[]
  -> current brief/projection
```

From a chat perspective:

```text
chat
  -> threads[]
```

A chat-scoped thread SHOULD use `scope_type='chat'` and `scope_id=<chat_id>` when the source chat is known. The same chat can carry many distinct Ravi threads.

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
- `current_assignee_type`: `user`, `agent`, `contact`, `system`, or future assignee class
- `current_assignee_id`
- `closed_reason`
- `closed_at`
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
- `kind`: `note`, `comment`, `prompt`, `answer`, `decision`, `summary`, `question`, `open_loop`, `source_ref`, `handoff_note`, `status_change`, `observer_comment`, `system`, or future kind
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
- `pinned`
- `importance`: `low`, `normal`, `high`, or future value
- `visibility`: `default`, `internal`, `private`, `restricted`, or future value
- `source_policy`: `reference_only`, `copy_allowed`, `redacted_copy`, or future policy
- `resolved_at`
- `metadata_json`
- `created_at`

Entries SHOULD store concise operational text. Large source bodies SHOULD be referenced, not copied, unless the source has no durable canonical store.

Comments are entries. `ravi threads comment` and `ravi sessions send --thread` SHOULD append a `comment`, `prompt`, or `handoff_note` entry as appropriate instead of mutating thread summary text directly.

### `thread_links`

Fields:

- `id`
- `thread_id`
- `target_type`: `contact`, `chat`, `session`, `agent`, `artifact`, `task`, `project`, `route`, `tag`, `url`, `file`, or future target
- `target_id`
- `role`: `participant`, `default-outbound`, `worker`, `assignee`, `watcher`, `subscriber`, `observer`, `source`, `origin`, `result`, `context`, `blocked-by`, `duplicate-of`, `split-from`, or future role
- `label`
- `visibility`: `default`, `internal`, `private`, `restricted`, or future value
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
- `brief_snapshot_json`
- `brief_snapshot_hash`
- `brief_renderer_version`
- `delivery_barrier`
- `status`: `queued`, `delivered`, `failed`, or `cancelled`
- `created_at`
- `delivered_at`
- `metadata_json`

Handoffs MUST be audit events. They explain when a thread was sent to a runtime, what prompt was sent with it, and which entries/sources were included in the brief.

When a handoff creates a missing thread, the handoff audit MUST record that the thread was created during send and which creation fields were used.

Brief snapshots SHOULD be compact audit projections, not a second unbounded history store. They exist to explain what the receiving agent saw at handoff time.

## CLI Surface

The CLI SHOULD keep thread operations direct and low ceremony:

```bash
ravi threads create <slug> --title "..."
ravi threads list [--status open] [--scope project:<id>]
ravi threads show <thread>
ravi threads note <thread> "..."
ravi threads comment <thread> "..."
ravi threads link <thread> contact:<id> --role participant
ravi threads link <thread> chat:<id> --role default-outbound
ravi threads entries <thread>
ravi threads close <thread>
```

Thread handoff SHOULD integrate with sessions:

```bash
ravi sessions send <session> --thread <thread> "continua daqui"
ravi sessions send <session> --thread <slug> --thread-title "..." "novo comentario"
```

The thread-specific command MAY exist as a convenience:

```bash
ravi threads send <thread> --to-session <session> "continua daqui"
```

But `ravi sessions send --thread` is the primary thread UX because it keeps the target runtime explicit.

When `--thread` references a missing slug, `sessions send` MAY create the thread as part of the send only if required creation fields are present on the same command. There SHOULD NOT be a separate `--create` flag for this baseline UX.

Required creation facts:

- slug from `--thread`;
- title from `--thread-title`;
- owner derived from caller or explicit owner flags;
- scope derived from source chat/session when available or explicit `--thread-scope`;
- initial comment/prompt body from the send message.

If Ravi cannot derive or validate the required creation facts, the command MUST fail before emitting to the target session.

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

The handoff audit SHOULD preserve a compact `thread_brief_snapshot` or hash/version pair for the exact projection sent to the target session. This snapshot is for audit/debugging and MUST NOT become the canonical thread state.

## Responsibility And Watchers

Thread ownership, responsibility, and subscription are separate concepts.

- `owner_type` and `owner_id` describe who owns or created the thread record.
- `current_assignee_type` and `current_assignee_id` describe who is expected to move the thread forward now.
- `thread_links` with role `assignee` MAY record assignment history or scoped responsibility.
- `thread_links` with role `watcher` or `subscriber` MAY record who should be notified about updates.

Changing assignee SHOULD append a `status_change`, `comment`, or future assignment event entry with actor provenance.

Watchers and subscribers are notification intent only. They MUST NOT imply permission to read private entries, send the thread to a session, or contact linked people.

## Visibility And Source Material

Threads can aggregate context from chats, contacts, sessions, files, artifacts, and URLs, so visibility must be explicit enough for safe brief construction.

Baseline visibility values:

- `default`: visible under normal thread read permissions.
- `internal`: visible to Ravi operators/agents with internal context access.
- `private`: visible only to explicitly authorized actors.
- `restricted`: must be omitted unless a specific policy grants access.

Brief builders MUST enforce entry and link visibility before rendering human-readable context. Private or restricted source bodies SHOULD be represented as omitted-context diagnostics or source refs when the receiving actor lacks access.

Source material policy:

- `reference_only`: store durable ids/provenance, not copied body text.
- `copy_allowed`: concise copied body text may be stored in the entry.
- `redacted_copy`: copied body text must be redacted before storage or brief rendering.

Large source bodies SHOULD default to `reference_only`. Copying private chat/session transcripts into thread entries MUST require an explicit policy decision.

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

## Thread Comments In Chat Flow

A chat can carry many active threads.

Safe flow:

```text
operator or agent sends a comment with --thread <slug>
  -> Ravi resolves the source chat and target session
  -> Ravi resolves the thread within the relevant chat/session scope
  -> if absent and creation facts are complete, Ravi creates the thread
  -> Ravi appends the comment as a thread entry
  -> Ravi sends the target agent a bounded thread brief plus the new comment
```

If the thread already exists, Ravi MUST reuse it and append the new comment. It MUST NOT create a duplicate thread just because the source session or target agent differs.

## Lifecycle

Allowed baseline statuses:

- `open`: thread exists and can receive entries.
- `active`: thread is currently being worked.
- `waiting`: waiting for a person, agent, task, or external signal.
- `blocked`: cannot continue without a required input or fix.
- `closed`: resolved but retained.
- `archived`: hidden from normal active views but retained.

Status changes MUST append a thread event or entry.

Closing a thread SHOULD record why it closed through `closed_reason`, `closed_at`, and a `status_change` or `summary` entry. Common closure reasons MAY include `resolved`, `abandoned`, `merged`, `split`, `converted-to-task`, or `ingested-to-knowledge`.

## Future: Merge And Split

Merge and split are future operations. They should be documented now to avoid ad hoc duplicate handling.

Merge expected behavior:

- One canonical thread remains open or active.
- The merged source thread is closed with reason `merged`.
- The source thread links to the canonical thread with role `duplicate-of`.
- Entries are not silently rewritten; provenance and original thread ids remain auditable.

Split expected behavior:

- A new thread is created for the subtopic.
- The new thread links back to the original with role `split-from`.
- Only selected entries/source refs are copied or referenced according to source material policy.
- The original thread keeps its identity and history.

## Future: Thread Observers

Thread observers are a future phase after storage, comments, links, and handoff are working and tested.

A thread observer is a lightweight Observation Plane sidecar scoped to one active thread and one source session. Its job is to watch what happened in the source session, evaluate whether the thread is complete or has next steps, and append comments back to the thread when useful.

Expected future model:

```text
active thread
  -> source session
  -> observer binding
  -> observer session with thread-completeness profile
  -> observer_comment entries
```

Future constraints:

- Thread observers SHOULD be created lazily for active or waiting threads, not for every historical thread.
- Thread observers SHOULD pause or stop when the thread becomes `closed` or `archived`.
- A thread observer MUST be isolated from the observed session prompt and runtime permissions.
- A thread observer MUST NOT send outbound messages to contacts.
- A thread observer MAY append `observer_comment`, `open_loop`, `question`, or `status_change` entries when permitted.
- Observer output MUST go through thread entries/comments, not direct prompt injection into the main agent session.

## Acceptance Criteria

- A thread can be created without creating a session.
- A thread can be linked to a contact and a chat without becoming either one.
- A chat can have multiple Ravi threads without those threads becoming chats or provider-native threads.
- A thread can be sent to an existing session with `ravi sessions send --thread`.
- `ravi sessions send --thread <missing-slug> --thread-title "..." "..."` can create a thread and deliver the first comment when creation facts are complete.
- `ravi sessions send --thread <existing-thread> "..."` appends a comment and reuses the existing thread.
- The target agent receives a bounded thread brief and the operator prompt in one delivery.
- The same thread can later be sent to another session and preserve the same subject context.
- Thread handoff does not bypass session REBAC, contact policy, or outbound target policy.
- Thread entries preserve enough actor/source provenance to audit where context came from.
- Assignee and watcher/subscriber relationships can be represented without granting permissions automatically.
- Brief construction respects entry/link visibility and source material policy.
- Handoff audit can explain what brief projection was sent without treating the snapshot as canonical thread history.

## Known Failure Modes

- Treating thread as another name for Knowledge and making simple continuation too heavy.
- Treating thread as a session and losing portability across agents.
- Treating thread as a chat and tying it to one transport conversation.
- Treating linked contacts as implicit permission to message them.
- Injecting the full thread history into every prompt and leaking private or irrelevant context.
- Depending on provider-native thread ids as Ravi thread ids.
- Creating duplicate thread concepts under `knowledge`, `runtime`, and `channels` without a clear boundary.
- Creating duplicate Ravi threads for the same chat-scoped slug instead of resolving and reusing the existing thread.
- Letting watcher/subscriber links accidentally grant read, handoff, or outbound permission.
- Copying private source transcripts into entries or briefs when source references would be safer.
- Treating brief snapshots as the source of truth instead of audit projections.
- Letting future thread observers mutate the main session prompt or send outbound content directly.
