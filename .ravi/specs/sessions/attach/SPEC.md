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

`sessions/attach` decouples a session from the chat that produced the current inbound turn and separates "the session is listening here" from "the session may speak here".

Attach is the single runtime wiring primitive for this capability:

1. **Subscription** — a session is attached to a chat so future inbound from that chat can dispatch into the same session without forking history.
2. **Speech mode** — every active subscription has a `speech_mode`:
   - `speak`: the session may emit external responses to that chat when the current inbound source is that chat.
   - `muted`: the session listens to that chat, but a normal response MUST NOT emit there.
3. **Default output attachment** — one active subscription MAY be selected as the session's default speak surface. It is used when the current source chat is muted/listen-only.

There is no separate `focus` primitive. The old `focus` behavior is folded into `attach` semantics and the old `focus` CLI/tool names MUST NOT exist.

## Boundary

This capability owns:

- the multi-chat subscription model;
- the per-subscription speech mode;
- the per-session default output attachment selected by `attach`;
- attach/mute/unmute/detach/list CLI surface;
- context-snapshot rendering at attach time;
- target resolution at emit time: source speak subscription -> default speak attachment -> fail closed.

This capability does NOT own:

- chat membership of humans (`channels/chats` / `chat_participants`);
- provider session state (`runtime/session-continuity`);
- thread/subject context (`threads`);
- identity resolution (`contacts/identity-graph`);
- permission system (Permission Provider Runtime);
- arbitrary broadcast to many chats. This feature selects one outbound surface per response, not fan-out.

## Definitions

- `session_chat_subscription`: durable record stating "chat X is wired to session S". A session MAY have many. The original `session_chat_bindings` row remains the primary/origin marker for backward compatibility.
- `speech mode`: durable per-subscription state. `speak` means the session may emit to that chat; `muted` means listen-only.
- `output attachment`: the active subscription row whose `output_attached_at` is set. At most one active subscription per session may be the default output attachment.
- `default output target`: the chat record referenced by the active output attachment.
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
- `speech_mode` — `speak` or `muted`. Defaults to `speak` for manual/default attaches and to `muted` for route-created listen-only subscriptions.
- `speech_updated_at`.
- `speech_reason` — short audit reason explaining the last speech-mode mutation.
- `output_attached_at` — non-null only when this row is the session's current default external output target.
- `created_at`, `updated_at`.
- `detached_at` — soft delete; the row is inactive when set.

Constraints:

- `(session_key, chat_id)` MUST be unique among active rows.
- `chat_id` MUST be unique among active rows across ALL sessions. A canonical chat row can only dispatch into one session at a time.
- `(session_key)` MUST be unique among active rows where `output_attached_at IS NOT NULL`. A session has at most one default output attachment.
- `speech_mode` MUST be independent from `output_attached_at`. A chat MAY be `speech=speak` without being the default output. A default output row MUST be `speech=speak`.
- A session MUST keep at least one active `primary` subscription for legacy compatibility. Detaching the last primary MUST clear output only; it MUST NOT orphan the input subscription.
- Legacy `session_focus` state MUST NOT affect output. Code MUST NOT read it, expose it, or document it.

## Migration From Current State

- `session_chat_bindings` becomes the `primary` subscription row.
- Primary rows backfilled from `session_chat_bindings` MUST become `speech=speak` output attachments when the session has no output attachment yet. This preserves normal chat reply behavior for existing sessions.
- Legacy duplicate bindings pick the most recently updated binding, tiebreak by `session_key`, and drop the rest from subscription backfill.
- Existing active subscriptions without speech metadata are backfilled as `speech=speak` when they are `primary` or the output attachment, and `speech=muted` otherwise.
- Existing active subscriptions without any output attachment are backfilled by selecting one row per session, preferring `primary`.
- Legacy `session_focus` rows are deleted.
- `sessions.last_channel` / `last_account_id` / `last_to` / `last_thread_id` remain last-source provenance only. They MUST NOT be output fallback.

## Target Resolution

When the runtime emits a response, the target chat MUST be resolved in this order:

1. **Speak-enabled source chat** — if the current inbound source chat is an active subscription for the session and has `speech_mode='speak'`, emit to that source chat.
2. **Default output target** — otherwise use the active subscription with `output_attached_at IS NOT NULL` only when it has `speech_mode='speak'`.
3. **Fail closed** — if neither target resolves, do not emit externally. Keep provider transcript/session state intact and emit a trace/log for `response.target_unresolved`.

The inbound source chat is NOT an implicit output fallback. It only wins when it is an active speak-enabled subscription. This is the key behavior: a session may receive prompts from one muted/listen-only chat while responses land in the default speak chat selected by `attach`.

Inbound route bookkeeping MUST be monotonic for an existing subscription: reprocessing the same source chat MUST NOT downgrade an active `primary` or default-output subscription to `speech=muted` just because the session already has a primary row. Only new secondary subscriptions created by routing default to listen-only.

## Runtime Chat Context

Attach makes a session multi-chat capable. Runtime prompt context MUST therefore distinguish the chat that produced the current prompt from the chat that receives the response.

For every inbound turn:

- `sourceChat` MUST refer to the canonical chat that produced the inbound message.
- `sourceSpeech` MUST state whether the source subscription is `speak`, `muted`, or absent.
- `defaultOutputChat` MUST refer to the canonical chat selected by the active output attachment, when one exists.
- The prompt header MUST include all active subscriptions with their `speech_mode` and default-output marker.
- If `sourceChat` and the default output chat are the same canonical chat, runtime context MAY render one chat section and mark output as same-as-source.
- If `sourceChat` and default output differ, runtime context MUST render them as separate concepts. It MUST NOT imply that participants from one chat belong to the other.
- Participant lists in prompt context MUST be scoped under `sourceChat.participants`, `defaultOutputChat.participants`, or the resolved outbound target. They MUST NOT be injected as a session-level participant list.
- Outbound channel features that depend on target membership, such as native mentions, MUST use the resolved outbound target's participants.
- Inbound interpretation features, such as sender metadata, quoted-message context, or inbound mention rendering, MUST use `sourceChat` metadata.
- If `sourceSpeech=muted`, the prompt MUST tell the agent that it may internally run `ravi sessions unmute <session> --chat <sourceChat>` before its final response when a public reply must go to the source chat.
- The prompt MUST explicitly instruct the agent not to explain mute, unmute, attach, subscription, routing, or output mechanics to users.

Example shape:

```ts
{
  sourceChat: { canonicalChatId: "<source-chat-id>", participants: ["<display-name>"] },
  sourceSpeech: "muted",
  defaultOutputChat: { canonicalChatId: "<output-chat-id>", participants: ["<display-name>"] },
  subscriptions: [{ canonicalChatId: "<source-chat-id>", speech: "muted", defaultOutput: false }]
}
```

Specs, tests, and normative examples MUST use placeholders instead of real person or group names.

## CLI Surface

```bash
# attach a chat as a speak-enabled subscription and default output target
ravi sessions attach <session> --chat <chat-id-or-key> [--reason "..."]

# keep a subscribed chat as listen-only
ravi sessions mute <session> --chat <chat-id-or-key>

# allow a subscribed chat to receive responses
ravi sessions unmute <session> --chat <chat-id-or-key>

# detach that chat/subscription from the session
ravi sessions detach <session> --chat <chat-id-or-key>

# list subscriptions, output target, and speech mode
ravi sessions subscriptions <session>
ravi sessions subscriptions <session> --json
```

Successful `ravi sessions attach` output MUST include the inverse detach command:

```text
Detach hint: ravi sessions detach <session> --chat <canonical-chat-id>
```

For `--json`, the same command MUST be returned under `hints.detach`.

Successful `ravi sessions subscriptions` output MUST include `speech=<mode>` for every subscription.

## Runtime Tool Surface

When native host tools exist for this capability, they MUST expose only:

```ts
attach_chat({ chat_id, reason? })
  -> { subscription_id, role: "input", output_attached: true, snapshot?: AttachContextSnapshot, hints: { detach: string } }

set_subscription_speech({ chat_id, mode: "muted" | "speak", reason? })
  -> { subscription_id, speech_mode: "muted" | "speak" }

detach_chat({ chat_id })
  -> { detached: boolean, output_detached: boolean }

list_subscriptions()
  -> { subscriptions: Subscription[] }
```

Tool rules:

- Tools MUST resolve `chat_id` against canonical chat ids only.
- Tools MUST emit session trace events for each mutation: `session.attach`, `session.detach`.
- `attach_chat` MUST return the inverse detach hint, mirroring the CLI.
- Speech-mode tools MUST NOT create subscriptions implicitly; the chat must already be attached.
- Tools MUST NOT include `focus_chat` or any equivalent separate output-target mutation.

## System Prompt Documentation

The system-prompt builder MUST document attach/mute/unmute/detach/list. It MUST NOT document `focus`.

The prompt SHOULD describe:

- `attach`: subscribe inbound from that chat, enable speech, and select it as default output;
- `mute`: keep inbound subscribed while preventing external responses to that chat; if the muted row was the default output attachment, clear `output_attached_at` so a default output row is never muted;
- `unmute`: enable speech in a subscribed chat, especially before final response when the source chat is muted and the reply must go there;
- `detach`: durably remove that subscription when possible; if detaching the only primary chat, input may remain but external output stops;
- `subscriptions`: inspect current wiring, default output, and speech mode.

The prompt MUST tell agents not to externalize the routing/mute/unmute mechanics to users.

## Silent vs Mute vs Detach

`@@SILENT@@`, `mute`, and `detach_chat` are complementary:

- **`@@SILENT@@`** is one-shot. The agent stays attached and suppresses only this turn's answer.
- **`mute`** is durable listen-only. The session keeps receiving inbound from that chat but does not emit there until `unmute`.
- **`detach_chat`** is durable removal. The session stops participating in that chat when possible.

## Session Surface Header

Ravi MUST prepend a compact internal header for every inbound turn in a multi-surface session so the agent understands where the inbound came from and where speech is allowed.

```text
[session surfaces] session=<session> source_chat=<chat_id> source_speech=<muted|speak|unattached> default_speak_chat=<chat-id|none>
[session surfaces] <chat-id> role=<role> speech=<mode> defaultOutput=<true|false> ...
[session surfaces] source_chat is muted/listen-only. If a public reply must go to source_chat, internally run `ravi sessions unmute <session> --chat <chat_id>` before your final response. Do not mention routing mechanics to users.
```

The header MUST include canonical chat ids. It MUST NOT suggest `focus`. It MUST NOT be framed as user-facing content.

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
- Inbound from other subscribed chats may still dispatch into `<session>`. If those chats are muted, normal output remains `<target-chat-id>`; if they are unmuted, responses to their own inbound may emit there.

### Listen To Another Group Without Speaking There

```bash
ravi sessions attach <session> --chat <listen-chat-id> --reason "listen there"
ravi sessions mute <session> --chat <listen-chat-id>
```

Effect:

- Future inbound from `<listen-chat-id>` dispatches into `<session>`.
- Normal responses do not emit to `<listen-chat-id>`.
- If a specific response must go back to that source chat, the agent may internally run `ravi sessions unmute <session> --chat <listen-chat-id>` before its final response.

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
- Falling back to inbound source for output when the source chat is not an active `speech=speak` subscription.
- Letting inbound-route bookkeeping steal the output attachment from an operator-selected chat.
- Letting inbound-route bookkeeping create speak-enabled secondary subscriptions by default. Secondary route-created subscriptions SHOULD be `speech=muted`.
- Treating attach as a permission grant. Subscribing a chat MUST NOT bypass `dmPolicy` / `groupPolicy`.
- Expecting attach to change which agent processes a chat. Attach chooses session/output continuity; agent comes from route or instance default.
- Having agents narrate mute/unmute/routing mechanics to end users.

## Acceptance Criteria

- `ravi sessions attach <session> --chat <chat>` selects `<chat>` as the session output target.
- After attaching `<chat>`, responses to inbounds from muted/listen-only subscribed chats are delivered to `<chat>`.
- Inbound from a speak-enabled source subscription emits to that source chat.
- Inbound route bookkeeping creates muted subscriptions and does not change the output attachment after it has been selected.
- Repeated inbound from the current primary/default chat preserves `speech=speak` and keeps the output attachment.
- `ravi sessions mute/unmute <session> --chat <chat>` toggles only speech mode and does not detach the input subscription.
- Muting the current output attachment clears the output marker instead of leaving a muted default output.
- `ravi sessions detach <session> --chat <chat>` clears output when `<chat>` is the output target.
- With no speak-enabled source and no speak-enabled output attachment, runtime does not emit externally.
- `ravi sessions subscriptions` shows which chat is the output target and the speech mode of each subscription.
- `ravi sessions focus`, `focus_chat`, and `set-unattached-focus-policy` are not available/documented.
- Deleting a session cascade-deletes its subscriptions.

## Validation

- `bun test src/router/session-attach.test.ts`
- `bun test src/runtime/session-output-target.test.ts`
- `bun test src/cli/commands/sessions.test.ts`
- `bun test src/omni/consumer-context.test.ts`
- `bun run build`
