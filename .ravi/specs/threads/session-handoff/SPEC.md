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

## Cross-Store Handoff Protocol

A thread handoff crosses from work-owned thread state to a core-owned target
session. Under the storage-by-workload split, thread, entry, and handoff records
are work-owned while session enqueueing is core-owned. This crossing MUST follow
the same intent/receipt discipline as `tasks/dispatch`.

- Thread entry, handoff, and delivery intent MUST commit atomically in work
  storage. The handoff MUST NOT be observable without its entry, and the
  delivery intent MUST NOT exist without its handoff.
- The handoff idempotency key MUST be stable across retries and derived from
  durable identifiers (handoff id, target session, renderer version). Retry MUST
  reuse the same key.
- A `payloadHash` MUST cover the rendered brief + operator prompt envelope and
  the brief renderer version (`thread_brief_renderer_version`). The existing
  `snapshot_hash`/`thread_brief_snapshot_hash` MAY serve as this hash.
- A handoff MUST be marked delivered only after a durable core enqueue receipt
  for the same handoff id and payload hash. Returning from an in-process publish
  call is NOT a durable receipt and MUST NOT alone flip status to `delivered`.
- Work modules MUST enqueue the handoff prompt through the typed core session
  port, not through untyped infrastructure.
- Replay with the same idempotency key and the same payload hash MUST be safe:
  it MUST NOT create a second entry, a second handoff, or a duplicate prompt.
- Replay with the same key but a conflicting payload hash MUST fail closed and
  surface repair evidence; it MUST NOT overwrite the prior handoff or deliver
  both payloads.
- Transient delivery failure MUST remain retryable with the same key. Terminal
  failure MUST move to an explicit dead-letter state that is repairable; the
  existing `failed` status MUST carry retryable-vs-terminal classification.
- When the work store is `unavailable`, delivery MUST defer and MUST NOT be
  marked delivered; `unavailable` MUST NOT be treated as `missing`.
- Cross-store handoff delivery MUST reference the shared storage outbox/receipt
  protocol once available and MUST NOT define a second generic outbox. This spec
  MUST NOT create or edit any storage spec subtree.
- Public `sessions send --thread` CLI/SDK return contracts MUST remain concrete.
  `@CliOnly()` and weak return-schema baseline expansion MUST NOT be used to
  avoid schemas.

### Handoff State Machine

Canonical handoff states:

- `intent` — entry, handoff, and delivery intent committed in work storage;
- `enqueued` — core returned a durable enqueue receipt for the handoff;
- `delivered` — receipt for the same handoff id and payload hash is durable;
- `timed_out` — no receipt within the delivery window; remote result unknown;
- `retry_scheduled` — transient failure/timeout left retryable evidence;
- `payload_conflict` — same key reused with a different payload hash;
- `dead_letter` — retries exhausted or terminal failure; repairable;
- `repair_required` — operator intervention needed.

```text
intent           -> enqueued | retry_scheduled | dead_letter | payload_conflict
enqueued         -> delivered | timed_out | retry_scheduled | payload_conflict
timed_out        -> retry_scheduled | delivered | dead_letter | repair_required
retry_scheduled  -> enqueued | dead_letter | repair_required
payload_conflict -> repair_required
repair_required  -> retry_scheduled | dead_letter
delivered        -> (terminal)
dead_letter      -> (terminal; repairable via a new handoff)
```

## Failure Matrix — Thread Handoff

Source intent is the work-owned entry + handoff + delivery intent. The core
receipt is the durable enqueue receipt/acknowledgement.

| Scenario | Source (work) state | Core state | Retry | Idempotency | Repair evidence |
| --- | --- | --- | --- | --- | --- |
| Crash before source commit | no entry/handoff/intent | no receipt | none; nothing committed | fresh key only after commit | none |
| Crash after source commit, before core request | `intent` | no receipt | re-enqueue with same key | same key + hash is safe replay | pending handoff row (`status=queued`) |
| Crash after core receipt, before source marks delivered | `intent`/`enqueued` | receipt exists | reconcile handoff to receipt | dedupe by receipt id + key | orphan receipt reconciled |
| Timeout, unknown remote result | `timed_out` | receipt/ack unknown | retry same key after backoff | replay dedupes on key + hash | timeout marker + attempts |
| Replay after acknowledgement loss | `enqueued` | receipt exists, ack lost | re-check ack; do not re-send new payload | same key + hash idempotent | ack ledger by handoff id |
| Payload-hash mismatch for existing key | `payload_conflict` | receipt for prior hash | blocked until repair | conflicting hash fails closed | conflict record with both hashes |
| Source (work) store unavailable | `unavailable` | n/a | defer; not delivered | no state change | unavailable read logged |
| Core (session) store unavailable | `intent` | enqueue fails/unknown | `retry_scheduled` same key | no false `delivered` | enqueue failure evidence |
| Unsupported renderer/protocol version | intent with unsupported version | receipt refused | no blind retry; escalate | `unsupported` never counts as delivered | version mismatch record |

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
- Thread entry, handoff, and delivery intent commit atomically in work storage.
- A handoff is marked delivered only after a durable core enqueue receipt for the same handoff id and payload hash, not on in-process publish return.
- Replay with the same idempotency key and payload hash does not create a duplicate entry, handoff, or prompt.
- A conflicting payload hash for an existing handoff key fails closed with repair evidence.
- The handoff defers rather than being marked delivered when the work store is unavailable.
