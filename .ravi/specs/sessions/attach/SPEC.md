---
id: sessions/attach
title: Session Attach
kind: capability
domain: sessions
capability: attach
tags:
  - sessions
  - chats
  - attach
  - routing
  - context
applies_to:
  - src/router/sessions.ts
  - src/router/router-db.ts
  - src/router/resolver.ts
  - src/omni/consumer.ts
  - src/runtime/host-event-loop.ts
  - src/cli/commands/sessions.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Session Attach

## Intent

`sessions/attach` decouples a session from the chat that produced the current inbound turn.

Attach is the single runtime wiring primitive for this capability:

1. **Attach** — a session is attached to a chat as its external output surface. That chat receives emitted responses from the session until another attach selects a different chat or detach clears the output attachment.
2. The same attach also creates an input subscription, so future inbound from that chat can dispatch into the same session without forking history.

There is no separate `focus` primitive. The old `focus` behavior is folded into `attach` semantics and the old `focus` CLI/tool names MUST NOT exist.

## Boundary

This capability owns:

- the multi-chat subscription model;
- the per-session output attachment selected by `attach`;
- attach/detach/list CLI surface;
- context-snapshot rendering at attach time;
- target resolution at emit time: output attachment -> fail closed.

This capability does NOT own:

- chat membership of humans (`channels/chats` / `chat_participants`);
- provider session state (`runtime/session-continuity`);
- thread/subject context (`threads`);
- identity resolution (`contacts/identity-graph`);
- permission system (REBAC);
- arbitrary broadcast to many chats.

## Definitions

- `session_chat_subscription`: durable record stating "chat X is wired to session S". A session MAY have many. The original `session_chat_bindings` row remains the primary/origin marker for backward compatibility.
- `output attachment`: the active subscription row whose `output_attached_at` is set. At most one active subscription per session may be the output attachment.
- `attached output target`: the chat record referenced by the active output attachment.
- `attach context snapshot`: an opt-in projection of attached chat metadata, rendered as a system context block in the next prompt.

## Data Model

### `session_chat_subscriptions`

Fields:

- `id` — primary key.
- `session_key` — references the session. NOT a unique constraint; a session has many subscriptions.
- `chat_id` — references the canonical chat id (`channels/chats`).
- `role`: `primary`, `input`, `mirror`, or future role.
- `attached_by_type`: `user`, `agent`, `system`.
- `attached_by_id`.
- `attached_reason` — short text explaining why, e.g. `manual-cli`, `agent-tool`, `route-migration`.
- `context_snapshot_at_attach_json` — optional snapshot of group/chat metadata captured at attach time.
- `output_attached_at` — non-null only when this row is the session's current external output target.
- `created_at`, `updated_at`.
- `detached_at` — soft delete; the row is inactive when set.

Constraints:

- `(session_key, chat_id)` MUST be unique among active rows.
- `chat_id` MUST be unique among active rows across ALL sessions. A canonical chat row can only dispatch into one session at a time.
- `(session_key)` MUST be unique among active rows where `output_attached_at IS NOT NULL`. A session has at most one output attachment.
- A session MUST keep at least one active `primary` subscription for legacy compatibility. Detaching the last primary MUST clear output only; it MUST NOT orphan the input subscription.
- Legacy `session_focus` state MUST NOT affect output. Code MUST NOT read it, expose it, or document it.

## Migration From Current State

- `session_chat_bindings` becomes the `primary` subscription row.
- Primary rows backfilled from `session_chat_bindings` MUST become output attachments when the session has no output attachment yet. This preserves normal chat reply behavior for existing sessions.
- Legacy duplicate bindings pick the most recently updated binding, tiebreak by `session_key`, and drop the rest from subscription backfill.
- Existing active subscriptions without any output attachment are backfilled by selecting one row per session, preferring `primary`.
- Legacy `session_focus` rows are deleted.
- `sessions.last_channel` / `last_account_id` / `last_to` / `last_thread_id` remain last-source provenance only. They MUST NOT be output fallback.

## Target Resolution

When the runtime emits a response, the target chat MUST be resolved in this order:

1. **Attached output target** — use the active subscription with `output_attached_at IS NOT NULL`.
2. **Fail closed** — if no output attachment resolves, do not emit externally. Keep provider transcript/session state intact and emit a trace/log for `response.target_unresolved`.

The inbound source chat is NOT an output fallback. This is the key behavior: a session may receive prompts from one chat while all responses land in the chat selected by `attach`.

## Runtime Chat Context

Attach makes a session multi-chat capable. Runtime prompt context MUST therefore distinguish the chat that produced the current prompt from the chat that receives the response.

For every inbound turn:

- `sourceChat` MUST refer to the canonical chat that produced the inbound message.
- `outputChat` MUST refer to the canonical chat resolved by the active output attachment, when one exists.
- If `sourceChat` and `outputChat` are the same canonical chat, runtime context MAY render one chat section and mark output as same-as-source.
- If `sourceChat` and `outputChat` differ, runtime context MUST render them as separate concepts. It MUST NOT imply that participants from one chat belong to the other.
- Participant lists in prompt context MUST be scoped under `sourceChat.participants` or `outputChat.participants`. They MUST NOT be injected as a session-level participant list.
- Outbound channel features that depend on target membership, such as native mentions, MUST use `outputChat.participants`.
- Inbound interpretation features, such as sender metadata, quoted-message context, or inbound mention rendering, MUST use `sourceChat` metadata.

Example shape:

```ts
{
  sourceChat: { canonicalChatId: "<source-chat-id>", participants: ["<display-name>"] },
  outputChat: { canonicalChatId: "<output-chat-id>", participants: ["<display-name>"] }
}
```

Specs, tests, and normative examples MUST use placeholders instead of real person or group names.

## CLI Surface

```bash
# attach a chat as the session output target and input source
ravi sessions attach <session> --chat <chat-id-or-key> [--reason "..."]

# detach that chat/output target from the session
ravi sessions detach <session> --chat <chat-id-or-key>

# list subscriptions and mark the output target
ravi sessions subscriptions <session>
ravi sessions subscriptions <session> --json
```

Successful `ravi sessions attach` output MUST include the inverse detach command:

```text
Detach hint: ravi sessions detach <session> --chat <canonical-chat-id>
```

For `--json`, the same command MUST be returned under `hints.detach`.

## Runtime Tool Surface

When native host tools exist for this capability, they MUST expose only:

```ts
attach_chat({ chat_id, reason? })
  -> { subscription_id, role: "input", output_attached: true, snapshot?: AttachContextSnapshot, hints: { detach: string } }

detach_chat({ chat_id })
  -> { detached: boolean, output_detached: boolean }

list_subscriptions()
  -> { subscriptions: Subscription[] }
```

Tool rules:

- Tools MUST resolve `chat_id` against canonical chat ids only.
- Tools MUST emit session trace events for each mutation: `session.attach`, `session.detach`.
- `attach_chat` MUST return the inverse detach hint, mirroring the CLI.
- Tools MUST NOT include `focus_chat` or any equivalent separate output-target mutation.

## System Prompt Documentation

The system-prompt builder MUST document attach/detach/list. It MUST NOT document `focus`.

The prompt SHOULD describe:

- `attach`: select the chat that receives all external responses from this session and subscribe inbound from that chat;
- `detach`: durably remove that output attachment; if detaching the only primary chat, input may remain but external output stops;
- `subscriptions`: inspect current wiring and the output target.

## Silent vs Detach

`@@SILENT@@` and `detach_chat` are complementary:

- **`@@SILENT@@`** is one-shot. The agent stays attached and suppresses only this turn's answer.
- **`detach_chat`** is durable. The session stops emitting external responses to that chat until a later explicit `attach`.

## Inbound Origin Hint

When inbound comes from a chat that is not the current output attachment, Ravi MUST prepend a hint so the agent understands why responding text may land elsewhere:

```text
[origin] inbound veio de <chat_id>. Esta sessão responde no chat atachado como output. Para fazer respostas saírem neste chat: `ravi sessions attach <session> --chat <chat_id>`. Para parar saída externa do output atual: `ravi sessions detach <session> --chat <output-chat-id>`.
```

The header MUST include canonical chat ids. It MUST NOT suggest `focus`.

## Instance Isolation

A chat MUST only be attached to a session whose instance matches the chat's instance.

Rules:

- `attachChatToSession` MUST throw `SessionAttachInstanceMismatchError` when `chat.instance != session.instance`.
- `subscriptionAllowsCrossInstance` MUST return false for cross-instance subscription overrides.
- Operators migrating chats across instances MUST detach from the original session and re-attach explicitly on a session that belongs to the target instance.

## Recipes

### Move Session Output To Another Group

```bash
ravi sessions attach <session> --chat <target-chat-id> --reason "reply there"
```

Effect:

- Future responses from `<session>` go to `<target-chat-id>`.
- Future inbound from `<target-chat-id>` also dispatches into `<session>`.
- Inbound from other subscribed chats may still dispatch into `<session>`, but output remains `<target-chat-id>`.

### Stop External Output

```bash
ravi sessions detach <session> --chat <output-chat-id>
```

Effect:

- If `<output-chat-id>` is the current output attachment, future responses do not emit externally until another `attach`.
- If the row can be removed without orphaning the primary subscription, the input subscription is also detached.
- If it is the only primary subscription, the primary input remains and only output is cleared.

## Anti-Patterns

- Reintroducing `focus`, `session_focus`, `focus_chat`, or a separate sticky output primitive. The primitive is `attach`.
- Falling back to inbound source for output when no output attachment exists.
- Letting inbound-route bookkeeping steal the output attachment from an operator-selected chat.
- Treating attach as a permission grant. Subscribing a chat MUST NOT bypass `dmPolicy` / `groupPolicy`.
- Expecting attach to change which agent processes a chat. Attach chooses session/output continuity; agent comes from route or instance default.

## Acceptance Criteria

- `ravi sessions attach <session> --chat <chat>` selects `<chat>` as the session output target.
- After attaching `<chat>`, responses to inbounds from other subscribed chats are delivered to `<chat>`.
- Inbound route bookkeeping creates subscriptions but does not change the output attachment after it has been selected.
- `ravi sessions detach <session> --chat <chat>` clears output when `<chat>` is the output target.
- With no output attachment, runtime does not emit externally.
- `ravi sessions subscriptions` shows which chat is the output target.
- `ravi sessions focus`, `focus_chat`, and `set-unattached-focus-policy` are not available/documented.
- Deleting a session cascade-deletes its subscriptions.

## Validation

- `bun test src/router/session-attach.test.ts`
- `bun test src/runtime/session-output-target.test.ts`
- `bun test src/cli/commands/sessions.test.ts`
- `bun test src/omni/consumer-context.test.ts`
- `bun run build`
