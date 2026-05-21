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
  - focus
  - routing
  - context
applies_to:
  - src/router/sessions.ts
  - src/router/router-db.ts
  - src/router/resolver.ts
  - src/omni/consumer.ts
  - src/runtime/host-event-loop.ts
  - src/runtime/host-tools.ts
  - src/cli/commands/sessions.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Session Attach

## Intent

Decouple a session from its origin chat.

Today a Ravi session is implicitly bound to the chat that created it, and the runtime emits output back to the chat of the most recent inbound. This forces a 1:1 chat↔session relationship and prevents a single agent's working memory from spanning the surfaces where work actually happens.

`sessions/attach` introduces two primitives:

1. **Attach (multi-input)** — a session MAY accept inbound dispatch from many chats. Each attached chat can deliver prompts into the same agent runtime without forking a new session.
2. **Focus (mutable output target)** — a session MAY have an explicit output target chat, controllable from the CLI and from inside the agent runtime via a tool call. When no focus is set, output goes to the chat of the inbound that produced the turn (legacy behavior preserved).

Motivation:

- **Continuous memory across surfaces.** An agent helping the user on WhatsApp can also be reached from a CLI session, from a Discord channel, or from a task dispatcher, while keeping one prompt history.
- **Controllable output.** The agent itself can decide "respond on the family WhatsApp instead of here" or "broadcast this to the ops channel" without the operator manually relaying.
- **Refresh context at boundary.** Attaching a new chat is a natural moment to pull fresh metadata (group description, member list, pinned topic, channel-specific capability info) and inject it into the next turn, so the agent enters the new surface already oriented.

## Boundary

This capability owns:

- multi-chat subscription model;
- focus target model;
- attach/detach/focus CLI and tool surface;
- context-snapshot rendering at attach time;
- target resolution at emit time (focus → last inbound → fail).

This capability does NOT own:

- chat membership of humans (`channels/chats` / `chat_participants`);
- provider session state (`runtime/session-continuity`);
- thread/subject context (`threads`);
- identity resolution (`contacts/identity-graph`);
- permission system (REBAC).

`sessions/attach` integrates with all of the above but MUST NOT redefine their contracts.

## Definitions

- `session_chat_subscription`: durable record stating "chat X is allowed to dispatch input into session S". A session MAY have many. The original `session_chat_bindings` row remains the primary/origin marker for backward compatibility.
- `session_focus`: optional pointer indicating which chat receives output by default. Mutable from CLI and from a runtime tool. Cleared by `detach` or by `focus --clear`.
- `default target`: when `session_focus` is unset, the output target is the chat of the inbound message that produced the current turn (legacy behavior).
- `attach context snapshot`: an opt-in projection of the attached chat's metadata, rendered as a system context block in the next prompt. Sourced from Omni-backed chat metadata, channel-specific capabilities, and any registered attach-hooks.

## Why Now

Concrete surfaces this unblocks:

- **Project-wide agent over many chats.** A `dev` agent that today only listens in `ravi - dev` group can also be attached to a customer chat without forking a separate `dev-customer` session.
- **Operator broadcast.** A session running a long task can `focus` the family chat to deliver a result, then `focus --clear` to return to the operator console.
- **Agent-driven handoff.** The agent itself can call `focus_chat({chat_id})` to redirect its next reply when it determines the answer belongs elsewhere — without losing the rest of the conversation.

## Data Model

### `session_chat_subscriptions`

New table.

Fields:

- `id` — primary key.
- `session_key` — references the session. NOT a unique constraint; a session has many subscriptions.
- `chat_id` — references the canonical chat id (`channels/chats`).
- `role`: `primary`, `input`, `mirror`, or future role. `primary` matches the existing `session_chat_bindings` row when present. `input` is a normal attached chat. `mirror` is reserved for future read-only attachments.
- `attached_by_type`: `user`, `agent`, `system`.
- `attached_by_id`.
- `attached_reason` — short text explaining why (e.g. `manual-cli`, `agent-tool`, `route-migration`).
- `context_snapshot_at_attach_json` — optional snapshot of group/chat metadata captured at attach time (see "Context Injection At Attach"). Stored for audit; the live prompt context MUST be rebuilt on demand, not read from this snapshot.
- `created_at`, `updated_at`.
- `detached_at` — soft delete; the row is preserved for audit, but the subscription is inactive when this is set.

Constraints:

- `(session_key, chat_id)` MUST be unique among active (non-detached) rows.
- `chat_id` MUST be unique among active (non-detached) rows across ALL sessions. A canonical chat row can only be attached to one session at a time. This naturally allows multi-instance attach (the "same conceptual group" joined via two different Omni instances produces two distinct canonical chat ids, and each may be attached to a different session — or both to the same session).
- A session MUST always have at least one active subscription with `role = 'primary'` after attach lands. Migrating existing `session_chat_bindings` MUST backfill a `primary` subscription per session.
- Attempting to attach a chat that is already attached to another session MUST fail closed with a clear error referencing the existing owner session. Operators can resolve by detaching from the previous session first.

### `session_focus`

New table (or columns on `sessions`, implementation choice).

Fields:

- `session_key` — primary key; one focus row per session at most.
- `chat_id` — current focus target. NULL means "default" (last inbound).
- `set_by_type`: `user`, `agent`, `system`.
- `set_by_id`.
- `set_reason` — short text.
- `expires_at` — optional TTL. When NULL the focus is sticky until explicitly cleared. When present the focus reverts to default at the timestamp.
- `created_at`, `updated_at`.

Constraints:

- `chat_id` MUST reference an active subscription for the same `session_key`. Setting focus to a chat that is NOT subscribed MUST follow the session's configured `unattached_focus_policy` (see below). Default is **fail closed**: the operator (or agent) MUST `attach` the chat first.
- Clearing focus MUST be an explicit operation (CLI `--clear` or tool `focus_chat({clear: true})`). Detaching the currently-focused chat MUST clear focus as a side effect.

### `sessions.unattached_focus_policy` (new column on `sessions`)

Per-session configuration governing what happens when `focus` is requested for a chat that is not yet subscribed.

Values:

- `fail-closed` (default) — focus to an unattached chat is rejected with an error. The caller (CLI operator or agent tool) must call `attach` first.
- `auto-follow` — the system auto-creates a subscription for the target chat (using `attached_by_type` of the focus caller and `attached_reason='auto-follow-on-focus'`) before setting focus.

This is **per-session** so an interactive operator session can opt into `auto-follow` for ergonomics while a production agent session keeps the safer `fail-closed` default.

CLI to set:

```bash
ravi sessions set <session> --unattached-focus-policy fail-closed|auto-follow
```

### Migration From Current State

- `session_chat_bindings` (one-to-one per `session_key` today) becomes the `primary` subscription row. The backfill MUST emit at most ONE `session_chat_subscriptions` row per `chat_id`, with `role='primary'`, `attached_by_type='system'`, `attached_reason='backfill-from-session-chat-bindings'`.
- Legacy `session_chat_bindings` only had `PK(session_key, chat_id)` and no cross-session UNIQUE on `chat_id`, so the same chat MAY appear in multiple bindings. When the backfill encounters duplicates, it picks the most recently updated binding (tiebreak by `session_key`) and drops the rest. The dropped bindings are NOT migrated; operators can manually `ravi sessions attach` to recover if needed.
- The migration also installs a dedupe step that soft-detaches any pre-existing duplicate active `session_chat_subscriptions` rows (keeping the most recent per chat) before installing the UNIQUE index on `chat_id`. This handles dev/test databases created by earlier non-unique iterations of this schema.
- `sessions.last_channel` / `last_account_id` / `last_to` / `last_thread_id` remain as last-source provenance. They MUST NOT be used as the focus target. They MAY be used as the default target when `session_focus.chat_id` is NULL.
- `route.session` (existing static redirect) remains unchanged. A route whose `session` field names an existing session continues to dispatch into that session — but now via the subscription mechanism: matching the route SHOULD ensure a subscription exists for the inbound chat, creating one if necessary (see "Compatibility With route.session").

## Target Resolution

Focus is **sticky** — once set, it persists until cleared or expired by TTL. It does not reset between turns.

When the runtime emits a response, the target chat MUST be resolved in this order:

1. **Explicit per-turn target** — if the response carries an explicit `target` (already supported via `RuntimeMessageTarget`), use it. No change from today.
2. **Focus** — if `session_focus.chat_id` is set and the subscription is still active, use that chat. Resolve channel/instance/threadId from the chat record.
3. **Inbound source** — fall back to the chat of the inbound message that produced this turn (today's behavior).
4. **Fail closed** — if none of the above resolves, drop the response and emit a runtime trace `response.target_unresolved`. Do NOT pick a chat from `last_*` fields silently.

Step 3 preserves backward compatibility for sessions that never attach more than one chat.

### Output Marking

When the resolved output target is NOT the chat of the inbound that produced the turn (focus is active or explicit per-turn target was set), the message MUST be delivered **silently** — no marker, no "[Ravi from another context]" prefix, no system quote. The receiver sees a normal message from the bot. Agents are expected to phrase responses appropriately for the target audience.

This applies uniformly across channels. A future operator-facing UI MAY render attached/focused output differently in logs and trace views, but the message body itself MUST NOT be mutated by the delivery layer.

## CLI Surface

```bash
# attach a chat to a session
ravi sessions attach <session> --chat <chat-id-or-key> [--reason "..."]
ravi sessions attach <session> --from-current-chat   # convenience when running inside a chat context

# detach
ravi sessions detach <session> --chat <chat-id-or-key>

# list subscriptions
ravi sessions subscriptions <session>
ravi sessions subscriptions <session> --json

# focus
ravi sessions focus <session> --chat <chat-id-or-key> [--reason "..."] [--expires "<duration>"]
ravi sessions focus <session> --clear
ravi sessions focus <session> --show
```

`<chat-id-or-key>` SHOULD accept:

- canonical chat id;
- `channel:instance:chat_id` triple;
- session-relative shortcuts like `@primary` or `@last-inbound`;
- chat slug when the chat has one (future).

The CLI MUST require explicit chat targeting when ambiguous. It MUST NOT guess.

## Runtime Tool Surface

The agent runtime exposes two host tools (skill-gated; see `runtime/skill-loading`):

```ts
attach_chat({ chat_id, reason? })
  -> { subscription_id, role: "input", snapshot?: AttachContextSnapshot }

detach_chat({ chat_id })
  -> { detached: true }

focus_chat({ chat_id?, clear?: boolean, reason?, expires_in?: string })
  -> { focus: { chat_id, expires_at? } | null }

list_subscriptions()
  -> { subscriptions: Subscription[], focus: Focus | null }
```

Tool rules:

- Tools MUST resolve `chat_id` against canonical chat ids only. They MUST NOT accept raw provider ids.
- Tools are **open** by REBAC — any agent running in a session can call them. Rationale: the response already exists in the session regardless; attach/focus only decide which surface receives it, and that decision is the agent's job. Per-chat send/receive permissions are still governed by `dmPolicy`/`groupPolicy` for that chat.
- Tools MUST emit session trace events for each mutation: `session.attach`, `session.detach`, `session.focus.set`, `session.focus.clear`.
- The `attach_chat` tool MAY return a context snapshot (see next section). The agent can choose to acknowledge it in the next turn.

## System Prompt Documentation

The system-prompt builder MUST document attach/detach/focus the same way it documents existing session tools (e.g. `sessions send`, `sessions notify`). Concretely:

- A canonical block in the system prompt SHOULD describe the four tools (`attach_chat`, `detach_chat`, `focus_chat`, `list_subscriptions`) with their parameters and when to use them.
- The block SHOULD include short examples:
  - "Continue this conversation on the family WhatsApp: `focus_chat({chat_id: 'chat:whatsapp:luis:dm:5511...', reason: 'response belongs to family chat'})`"
  - "Pull this chat into my session so I can keep replying here: `attach_chat({chat_id: '...', reason: 'ongoing collab'})`"
- The block SHOULD link conceptually to inbound-from-unattached header copy so the agent can connect "I received this message with an attach hint" to "I can call `attach_chat`".
- The block MUST be skill-gated like the other session tools; agents without the gate do not see it.

The exact wording is implementation detail, but the builder MUST surface these tools next to `sessions send` and `sessions notify` so the agent's mental model treats them as peers.

### Silent Reply vs Detach

`@@SILENT@@` and `detach_chat` are complementary, not substitutes. The system prompt MUST document the distinction clearly.

- **`@@SILENT@@`** is a **one-shot** signal for the current turn. The agent acknowledged the inbound but has nothing to say right now. The next inbound in the same chat triggers a normal turn — the chat is NOT removed from the session.
  - Use when: "I read this, but no response is needed this turn."

- **`detach_chat`** is a **durable state change**. The agent leaves the chat: it no longer receives or sends messages from/to that chat until an explicit `attach_chat` re-subscribes it.
  - Use when: "I want to work in silence on this surface, or move attention to another channel without accidental noise here."

The system prompt SHOULD present them as a pair with this contrast so the agent picks the right tool for the intent (transient quiet vs persistent disengage).

## Inbound From An Unattached Chat

A session MAY receive inbound dispatch via mechanisms outside the subscription model: a `route.session` redirect, a `sessions send` from another session, an explicit task dispatch, or a future thread handoff. When the inbound chat is NOT currently in the session's active subscriptions, the consumer MUST prepend a system header to the rendered prompt explaining the origin and how the agent can opt in to that chat:

```text
[System] Origem não-atachada
Esta mensagem veio do canal <channel> (chat <chat-id-or-slug>) que NÃO está atachado à sessão.
Para responder lá em vez de aqui, chame attach_chat({chat_id: "<chat-id>"}) e opcionalmente focus_chat({chat_id: "<chat-id>"}).
Sem attach, a próxima resposta vai para o destino padrão (último inbound ou foco atual).
```

Header rules:

- The header MUST be a single system block prepended to the inbound prompt — it MUST NOT be sent to the original chat.
- The header MUST include the canonical `chat_id` so the agent can call `attach_chat`/`focus_chat` correctly.
- The header MUST be omitted when the inbound chat is in the active subscriptions (the normal path).
- The header MUST be omitted for non-channel sources that don't have a chat at all (CLI prompts from `ravi sessions send` without `--from-chat`, task dispatches, system commands).

This makes attach discoverable to the agent without polluting the conversation. The agent decides whether to attach.

## Context Injection At Attach

Attaching a new chat is a natural seam to inject fresh metadata so the agent enters the new surface oriented.

When a chat is attached (via CLI or via tool), Ravi SHOULD:

1. Pull current metadata from the canonical chat record and from Omni (group title, description, topic, pinned info, member count, channel capability flags relevant to that chat).
2. Execute registered **attach hooks** — capability-scoped actions that can return fresh data. Examples:
   - WhatsApp group: latest invite link state, admin list, group description.
   - Discord channel: current topic, slow-mode setting.
   - Project-linked chat: open tasks count, recent artifacts.
3. Render the result as a system context block in the next prompt:

   ```text
   [System] Attached chat: <chat-name>
   Channel: whatsapp / instance: luis
   Description: ...
   Members (N): ...
   Recent activity: ...
   Attach hooks:
     - tasks: 3 open
     - artifacts: 12 in last 7d
   ```

4. Persist the snapshot on the subscription row (`context_snapshot_at_attach_json`) for audit. Live prompts MUST rebuild context from current sources, not from the snapshot.

Hook contract (high level — detailed contract is out of scope for this spec):

- Hooks are pure, read-only.
- Hooks have a bounded budget (token + latency).
- Hooks MAY fail individually without aborting attach. Failed hooks are recorded in trace.
- Hooks are registered by capability/channel, not by ad hoc agent code.

Attach context injection is opt-in per attach call (flag `--with-context` on CLI, `with_context: true` on tool). The default SHOULD be true for `attach_chat` from the agent (the agent usually wants the context) and configurable per session for CLI use.

## Compatibility

### With `route.session`

`route.session` performs a static name-based redirect at routing time. After attach lands:

- Matching a route with `session: <name>` MUST ensure an active subscription exists between the inbound chat and the named session. If absent, the consumer creates one with `attached_by_type='system'`, `attached_reason='route-redirect'`.
- `route.session` continues to work without operator intervention.
- Operators MAY also manually `ravi sessions attach` the same chats; the subscription is idempotent.

### With `dmScope`

`dmScope` determines the shape of `session_key` at route resolution (`per-peer` vs `main` vs `per-channel-peer` vs `per-account-channel-peer`). It controls *which session* an inbound resolves to.

- `dmScope` continues to govern *route → session* resolution. Attach happens AFTER session resolution.
- A `dmScope: 'main'` agent that today shares one session across all peers continues to work. Attach simply makes this explicit and inspectable.
- A `dmScope: 'per-peer'` agent will create a separate session per peer (unchanged). Multi-chat continuity for that agent now goes through explicit `attach`, not through `dmScope` widening.

### With `dmPolicy`

`dmPolicy` (open/closed/allowlist/pairing) gates inbound dispatch. Attach is a separate decision layer:

- Inbound from an attached chat MUST still pass the policy check for that chat. Attach is wiring; it does not bypass policy.
- The `route.rejected` trace (see `contacts/identity-graph/unified-model`) MUST fire normally when a policy gate blocks an inbound from an attached chat.

### With `channels/chats`

- `session_chat_bindings.role` (when added) MUST stay aligned with the new subscription `primary` role.
- `chat_participants` is the canonical membership; attach does NOT modify it.
- `session_participants` MAY gain new rows as humans interact through attached chats (unchanged contract).

### With `threads/session-handoff`

Threads and attach are complementary:

- A thread sends a **one-shot** prompt+brief into a session, optionally creating subscriptions if the thread defines a default outbound chat.
- Attach is **persistent** input wiring.

A thread MAY trigger attach as a side effect when `thread_links` declare a `default-outbound` chat that isn't yet attached, but only with explicit operator confirmation.

## Runbook

### Attach a chat to an existing session

```bash
ravi sessions attach dev --chat chat:whatsapp:luis:group:120363424772797713
# OR, from inside a chat:
ravi sessions attach dev --from-current-chat
```

Effect:

1. Insert subscription row.
2. Run attach hooks (if `--with-context`, default true on agent tool).
3. Render context snapshot for next turn.
4. Emit `session.attach` trace event with reason and actor.

### Detach a chat

```bash
ravi sessions detach dev --chat chat:whatsapp:luis:group:...
```

Effect:

1. Soft-delete subscription (`detached_at = now`).
2. If `session_focus.chat_id` was the detached chat, clear focus.
3. Emit `session.detach` trace.

A `primary` subscription MUST NOT be detached while it's the only active subscription. The detach MUST fail closed with a clear error.

### Set focus

```bash
ravi sessions focus dev --chat chat:whatsapp:luis:group:family
ravi sessions focus dev --chat chat:cli:terminal:luis --expires 30m
ravi sessions focus dev --clear
```

Effect:

1. Validate that the target chat has an active subscription. If not, apply the session's `unattached_focus_policy` (default `fail-closed`; `auto-follow` creates the subscription).
2. Write `session_focus` row.
3. Emit `session.focus.set` or `session.focus.clear` trace.

### Agent-driven focus (runtime tool)

The agent calls `focus_chat({ chat_id: 'chat:...', reason: 'reply belongs on family chat' })` from inside a turn. The next response from that turn (and subsequent turns until cleared or expired) goes to the new chat. The operator sees the trace.

### Return to default

```bash
ravi sessions focus dev --clear
```

Or the agent calls `focus_chat({ clear: true })`. Output reverts to "the chat of the last inbound message".

## Checks (Invariants)

- A session has at most one active focus at any time.
- A session always has at least one active subscription (the `primary` row).
- Output emission MUST go through the resolution order in "Target Resolution". No path may emit to `last_*` fields directly without first checking focus.
- Detaching the focused chat MUST clear focus before the next emit.
- Attach MUST be idempotent: re-attaching an already-active chat MUST NOT create a duplicate active subscription. It MAY refresh `updated_at` and re-run hooks.
- Renaming a session (`updateSessionName`) MUST NOT touch subscriptions or focus.
- Resetting a session (`resetSession`) clears provider continuity (per `runtime/session-continuity`) but MUST NOT touch subscriptions or focus, since those are wiring not provider state.
- Deleting a session MUST cascade-delete subscriptions and focus rows.
- Subscription mutations MUST emit session trace events for audit.

## Resolved Decisions

The following decisions are settled and are baked into the rules above. Recorded here for traceability.

- **Focus lifetime:** sticky. Focus persists until explicitly cleared or until `expires_at` elapses. There is no per-turn one-shot mode.

- **Focus to an unattached chat:** **fail closed by default** (`unattached_focus_policy = 'fail-closed'`). A session MAY opt into `auto-follow` per-session for ergonomics; the default is the safer fail-closed.

- **Historical context on attach:** the agent sees messages **from the attach point forward only**. The session itself IS the history; attach does NOT replay old messages from the chat into the prompt. New messages arriving from the attached chat are identified by their channel/chat of origin in the inbound envelope so the agent can tell them apart from other attached surfaces.

- **Multi-instance attach:** allowed. A session MAY subscribe to chats that live on different Omni instances. The data model already supports this because the canonical `chat_id` is per-instance, so each (instance, conceptual-chat) pair is a distinct subscription target.

- **REBAC scope:** **open**. Any agent or operator running in a session can call attach/detach/focus. Rationale: the agent's response already exists in the session; these tools only decide which chat surface receives it. Per-chat policy (`dmPolicy`, `groupPolicy`, contact scope) still gates whether the chat can send/receive — those checks are NOT bypassed.

- **Cross-agent conflict:** a canonical `chat_id` can be attached to at most ONE session at a time. Two sessions handled by two different agents MAY attach the "same conceptual chat" only if they enter via different Omni instances (which produces two distinct canonical chat ids). Within a single instance, the second attach attempt fails closed with an error referencing the current owner session.

- **Output marking:** **silent**. Messages delivered to a focused/attached chat that is NOT the inbound source MUST NOT carry any visible marker, prefix, or system quote. Phrasing for the audience is the agent's responsibility. Operator-facing logs and traces MAY render the context, but the user-visible message stays clean.

- **System prompt + inbound header:** see "Inbound From An Unattached Chat" and "System Prompt Documentation" above. Inbounds from unattached chats prepend a system block describing the origin and the `attach_chat` opt-in. The system prompt builder documents attach/detach/focus alongside the existing session tools.

## Deferred / Out Of Scope

These are intentionally not specified here and SHOULD be addressed in follow-up work:

- **Detailed inventory of attach hooks.** The "Context Injection At Attach" section sets the contract (read-only, bounded, fail-isolated, capability-registered). The concrete shipping list (group metadata, member list, recent activity, project tasks count, artifacts count) and the registration API live in a separate feature spec.

## Acceptance Criteria

When this capability is implemented, all of the following SHOULD hold:

- A session can be attached to a second chat without forking a new session.
- Inbound messages from any attached chat dispatch into the same session, sharing prompt history.
- Each inbound still passes its chat's `dmPolicy` / `groupPolicy` / contact-scope check independently.
- `route.session` continues to work; matching a route with `session` ensures a subscription exists.
- Setting focus redirects output to a different attached chat for subsequent turns until cleared or expired.
- The agent runtime can set focus via a host tool call, and the next response is delivered to the focus target.
- Clearing focus returns output to the inbound-source default.
- Detaching the focused chat clears focus before the next emit.
- Attach via the runtime tool can optionally inject a context snapshot of the target chat into the next prompt.
- `sessions trace <session>` shows attach/detach/focus events with actor and reason.
- Deleting a session cascade-deletes its subscriptions and focus.
- Migration from `session_chat_bindings` is non-destructive: existing one-to-one bindings become `primary` subscriptions.

## Known Failure Modes

- Treating attach as a permission grant: subscribing a chat MUST NOT bypass `dmPolicy` for that chat's inbound.
- Treating focus as a permission grant: setting focus MUST NOT bypass outbound policy for that chat.
- Resolving output target from `sessions.last_to`/`last_channel`/`last_account_id` after focus is set — focus MUST take precedence.
- Letting the runtime tool accept raw provider ids; chat targeting MUST go through canonical chat ids.
- Letting an agent silently attach a chat the operator didn't expect — every attach MUST trace with actor and reason.
- Snapshot drift: confusing the audit `context_snapshot_at_attach_json` with live prompt context. Snapshots are for audit; live prompts MUST rebuild context.
- Detaching the only `primary` subscription and orphaning the session — MUST be prevented.
- Cross-agent attach causing duplicate dispatch — prevented by the unique `chat_id` constraint on active subscriptions. Two agents on the same instance cannot attach the same chat; multi-instance attach uses distinct canonical chat ids per instance.
- Focus TTL expiring mid-turn: the focus MUST remain valid for the duration of an in-flight turn; expiry applies to the *next* turn.
