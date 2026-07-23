---
id: threads/session-handoff
title: "Thread Session Handoff"
kind: capability
domain: threads
capability: session-handoff
capabilities:
  - sessions-send-thread
  - thread-briefs
  - runtime-context
tags:
  - threads
  - sessions
  - runtime
applies_to:
  - src/cli/commands/sessions.ts
  - src/runtime/runtime-request-builder.ts
  - src/runtime/message-types.ts
  - src/runtime/session-dispatcher.ts
  - src/threads
owners:
  - ravi-dev
status: draft
normative: true
---

# Thread Session Handoff

## Intent

`ravi sessions send --thread` lets an operator continue a portable thread inside a concrete agent session.

The command should attach thread context without hiding the target runtime. The operator chooses the session, and Ravi attaches the thread context in a bounded, auditable way.

## Command Contract

Primary UX:

```bash
ravi sessions send <nameOrKey> --thread <thread> "prompt"
```

Examples:

```bash
ravi sessions send dev --thread rafa-pricing "continua daqui"
ravi sessions send dev --thread rafa-pricing --thread-title "Dúvidas com Rafa sobre pricing" "primeiro comentário"
ravi sessions send agent:crm:main --thread lead-acme "prepara follow-up curto"
```

The existing `sessions send` behavior remains the base behavior:

- target resolution still uses session name/key plus optional `--agent`;
- `--channel`, `--to`, `--barrier`, `--wait`, and `--json` should keep their existing semantics unless explicitly incompatible;
- Permission Provider Runtime and scope enforcement MUST match normal `sessions send`.

## Resolution Flow

Expected flow:

```text
parse sessions send args
  -> resolve target session
  -> validate caller can send to target session
  -> resolve thread by id or slug
  -> if missing and creation facts are complete, create the thread
  -> validate caller can read thread
  -> append the send message as a thread entry
  -> build bounded thread brief for target session
  -> persist thread_handoff queued
  -> emit prompt to session with structured thread context
  -> mark handoff delivered or failed
```

Thread resolution MUST NOT create an underspecified thread silently.

When `--thread` names a missing slug, Ravi MAY create the thread during `sessions send` only if the same command provides or can derive all required creation facts. This baseline UX SHOULD NOT require a separate `--create` flag.

Required creation facts:

- slug from `--thread`;
- title from `--thread-title`;
- owner from caller context or explicit owner flags;
- scope from source chat/session context or explicit `--thread-scope`;
- initial comment/prompt body from the send message.

Creation MUST happen before emission to the target session. If any required creation fact cannot be resolved safely, the command MUST fail before emitting.

If thread slug is ambiguous, Ravi MUST fail with a clear ambiguity error instead of choosing one.

Thread lookup SHOULD resolve by immutable id first. Slug lookup SHOULD be scoped by the current chat/session or explicit thread scope before falling back to broader owner/workspace scope. Ambiguous slug matches MUST be shown to the operator when possible.

## Prompt Shape

The target session should receive a system-originated envelope, not raw user text pretending to be the thread.

Suggested human-readable shape:

```text
[System] Thread Context: [thread: rafa-pricing]
Title: Dúvidas com Rafa sobre pricing
Status: open
Summary: ...
Linked targets:
- contact:Rafa participant
- chat:WhatsApp DM default-outbound
Recent entries:
1. ...
Open loops:
- ...

[System] Inform: [from: <origin-session>, thread: rafa-pricing] <operator prompt>
```

The exact copy MAY change, but these constraints are fixed:

- the thread brief MUST be visibly system context;
- the operator prompt MUST remain distinguishable;
- the raw thread history MUST NOT be dumped unbounded;
- entry/source ids included in the brief MUST be recorded in the handoff audit row.
- when the thread was created during send, the prompt SHOULD make that visible as system context.
- the handoff SHOULD record a compact brief snapshot or `brief_snapshot_hash` plus renderer version for audit/debugging.

## Structured Context

Runtime source/context metadata SHOULD include:

- `thread_id`
- `thread_slug`
- `thread_title`
- `thread_handoff_id`
- `thread_entry_ids`
- `thread_link_ids`
- `thread_default_contact_id`
- `thread_default_chat_id`
- `thread_created_during_send`
- `thread_brief_snapshot_hash`
- `thread_brief_renderer_version`
- `origin_session_key`
- `target_session_key`

Host tools SHOULD receive structured thread context out of band.

Tools MUST NOT infer permissions from the rendered brief alone.

## Brief Selection

The brief builder SHOULD prioritize:

1. current summary;
2. explicitly pinned entries;
3. recent decisions;
4. recent open questions;
5. recent prompts/answers;
6. default outbound target hints;
7. source references relevant to the target session.

The brief builder MUST respect:

- caller permissions;
- target session permissions;
- contact/chat privacy policy;
- thread entry/link visibility;
- source material policy;
- token budget;
- private source visibility;
- source availability.

Omitted context SHOULD be represented as metadata or diagnostics, not silently ignored when it affects behavior.

## Delivery Barrier

Default delivery barrier SHOULD remain compatible with normal `sessions send`.

If the target session is active, the existing dispatcher interruption and delivery barrier rules decide when the prompt is delivered. Thread handoff MUST NOT introduce a separate provider-specific interruption model.

## Wait Mode

When `--wait` is used, the command SHOULD stream the target session response normally.

The `--json` output SHOULD include:

- normal send payload fields;
- `thread.id`;
- `thread.slug`;
- `threadHandoff.id`;
- number of entries included;
- number of links included;
- whether the thread was created during send;
- omitted context count/reasons when available.

## Audit

Every handoff attempt MUST create or update an audit row/event.

Required audit facts:

- who initiated it;
- origin session when available;
- target session and agent;
- target thread;
- whether the target thread was created or reused;
- prompt length;
- included entry ids;
- included link ids;
- brief snapshot hash or renderer version when available;
- delivery barrier;
- outcome and error reason if failed.

## Failure Modes

The command MUST fail closed when:

- target session cannot be resolved;
- caller cannot send to target session;
- thread cannot be resolved;
- thread does not exist and required creation facts are incomplete;
- thread creation fails or cannot be audited;
- caller cannot read the thread;
- thread slug is ambiguous;
- brief cannot be built safely;
- structured context cannot be attached or audited.

The command SHOULD still allow normal `sessions send` without `--thread` when thread resolution fails before emission.

## Acceptance Criteria

- `ravi sessions send dev --thread rafa-pricing "continua daqui"` sends exactly one prompt to `dev`.
- `ravi sessions send dev --thread rafa-pricing --thread-title "Dúvidas com Rafa sobre pricing" "primeiro comentário"` can create a missing chat-scoped thread and send exactly one prompt to `dev`.
- Sending again with the same resolved thread appends a new entry and reuses the thread.
- The target prompt includes a bounded thread brief and the operator instruction.
- The runtime trace and emitted event metadata include `thread_id`.
- A handoff audit record shows what context was included.
- The handoff audit record shows whether the thread was created or reused.
- The handoff audit record can explain the brief projection sent to the target session through included ids plus snapshot/hash metadata.
- A second agent can receive the same thread later and continue from the same thread state.
- Provider adapters do not need to know about thread storage. They only receive Ravi-owned prompt/context.
