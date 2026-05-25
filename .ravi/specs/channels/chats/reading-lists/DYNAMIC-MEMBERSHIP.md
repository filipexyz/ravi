---
id: channels/chats/reading-lists/dynamic-membership
title: Dynamic Reading List Membership Engine
kind: feature
domain: channels
capability: chats
feature: reading-lists
sub_feature: dynamic-membership
tags:
  - channels
  - chats
  - reading-lists
  - selectors
  - declarative
  - tag-rules
  - membership-engine
applies_to:
  - src/reading-lists/types.ts
  - src/reading-lists/engine.ts
  - src/reading-lists/db.ts
  - src/cli/commands/chats.ts
  - src/router/router-db.ts
  - src/cron/runner.ts
extends:
  - channels/chats/reading-lists
related:
  - tags
  - channels/chats/reading-lists
owners:
  - ravi-dev
status: draft
normative: true
---

# Dynamic Reading List Membership Engine

## Intent

The dynamic membership engine resolves which chats belong to a chat reading list **declaratively**, by evaluating a selector expression against current state (contact tags, chat tags, message activity, last inbound age, contact status).

It implements the `mode: dynamic` semantic already declared in the parent spec (`channels/chats/reading-lists`). Where `static` lists require imperative `add` / `remove` calls, `dynamic` lists DECLARE who belongs and the engine keeps membership synchronized as state evolves.

The schema already contemplates this: `chat_reading_lists.selector_json TEXT`, `chat_reading_lists.mode TEXT NOT NULL DEFAULT 'static'`, and `chat_reading_list_members.source TEXT NOT NULL DEFAULT 'manual'` (with `'selector'` recognized as a valid source). This spec defines the engine that makes those fields functional.

## Core Concepts

- `selector`: declarative expression matching a chat (via its primary contact) to a list. Stored in `chat_reading_lists.selector_json`. Validated at write time.
- `dynamic mode`: list whose membership is exclusively derived from its selector.
- `hybrid mode`: list whose membership is the UNION of manual members and selector-derived members. OPTIONAL in MVP; if implemented, manual members are preserved across selector ticks.
- `evaluation cycle`: one pass of the engine over (a) all dynamic lists for a triggered contact/chat (reactive), or (b) all dynamic lists for all eligible contacts/chats (periodic).
- `member source`: every `chat_reading_list_members` row records `source` so audit can attribute origin. Engine-inserted rows MUST set `source = 'selector'`.
- `vocabulary reuse`: the selector REUSES the existing `ContactCondition` and `ChatCondition` schemas defined in `src/tag-rules/types.ts:15-78`. NO new DSL is introduced.

## Product Rule

The engine answers exactly one question:

```
For this list, given the current state of contacts/chats, which chats should be active members right now?
```

It MUST NOT answer:

```
What should I tag this contact with?       (tag-rules' responsibility)
What lifecycle stage is this contact in?   (CRM / observer plane)
What is unread in this list for me?        (cursor / delta query)
```

The engine MUST NOT emit tag mutations. Tags are read-only inputs.

## Selector Schema

```yaml
selector:
  scope: contact          # required: 'contact' or 'chat'
  match: all              # MVP: 'all' (AND) only. 'any' (OR) MAY be added later.
  conditions:             # array of conditions valid for the scope
    - { kind: has-tag, tag: cobranca:em-aberto }
    - { kind: not-has-tag, tag: cliente:vip }
    - { kind: last-inbound-age, operator: '>', duration: 7d }
```

Conditions valid for `scope: contact` are exactly those listed in `ALLOWED_CONDITION_KINDS_FOR_SCOPE.contact` in `src/tag-rules/types.ts:81-89`:

- `has-tag`
- `not-has-tag`
- `has-any-tag`
- `has-all-tags`
- `last-inbound-age`
- `status`
- `has-chat-with` (with nested chat conditions)

Conditions valid for `scope: chat` are exactly those in `ALLOWED_CONDITION_KINDS_FOR_SCOPE.chat`:

- `any-message-text-matches` (regex, optional `lastN`, optional `from`)
- `message-count`
- `last-inbound-age`
- `chat-type`
- `has-tag`
- `not-has-tag`

Selector validation MUST use the same Zod parsers already exported from tag-rules. Invalid selectors MUST be rejected at write time (`chats lists create` and `chats lists set selector ...`). The engine MUST NOT attempt to silently coerce invalid input.

## Membership Lifecycle

For each `(list, chat)` pair under dynamic evaluation, the engine MUST follow this state machine:

| Selector match | Active member exists | Action |
|---|---|---|
| MATCHED | NO | `INSERT` new member with `source = 'selector'`, `removed_at = NULL` |
| MATCHED | YES | no-op (idempotent) |
| NOT MATCHED | YES | `UPDATE removed_at = now()` (soft delete) |
| NOT MATCHED | NO | no-op |
| RE-ENTRY (matched after prior removal) | row exists with `removed_at IS NOT NULL` | `UPDATE removed_at = NULL` on the SAME row (preserves member id + audit) |

The unique index `idx_chat_reading_list_members_active(list_id, chat_id) WHERE removed_at IS NULL` (already declared in the schema migration) enforces at-most-one-active-row-per-pair under concurrency. The engine MUST handle the constraint via `ON CONFLICT DO NOTHING` or equivalent.

Membership rows MUST NEVER be hard-deleted by the engine. Soft-delete is required to:

- preserve audit history
- preserve cursor independence (see next section)
- allow re-entry to reuse the same member id

## Cursor Independence

`chat_reading_cursors` is keyed by `UNIQUE(list_id, chat_id, reader_type, reader_id)` (router-db.ts:1077). Crucially, this key DOES NOT reference `chat_reading_list_members.id`. Cursors are bound to the (list, chat, reader) triple, not to specific member rows.

Therefore:

- The engine MUST NOT touch `chat_reading_cursors` during membership transitions.
- Cursors MUST survive entry → exit → re-entry without reset.
- Acceptance test: Reader R reads list L up to message M in chat C. C exits L (removed_at set). C re-enters L (removed_at cleared). R's cursor MUST still point at M.

This invariant is what makes "leave and come back" semantically safe and is core to operational use cases (e.g., a customer whose debt is paid, then later returns delinquent — the cursor preserves audit continuity).

## Evaluation Model

The engine MUST support BOTH reactive AND periodic evaluation. Both MUST converge to the same membership state (eventual consistency, idempotent).

### Reactive

The engine subscribes to the NATS topic `ravi.tags.rule.applied`, which is already emitted by `src/tag-rules/engine.ts:147` and `:282` whenever a tag is added or removed on a contact or chat.

On event payload `{ contactId?, chatId?, added: string[], removed: string[] }`, the engine:

1. Looks up the affected lists via a reverse index `tag_slug → Set<list_id>` built at load time from parsed selectors.
2. For each affected list, evaluates the selector against the affected contact/chat only (NOT a full scan).
3. Applies membership transitions per the state machine above.

Reactive latency target: ≤500ms per event.

Reactive evaluation MUST NOT cascade tag changes. The engine never emits tags; only membership events.

### Periodic

A new CLI command `ravi chats lists tick [--list <id>] [--apply] [--limit <n>] [--json]` evaluates dynamic lists against all eligible contacts/chats.

- Default is dry-run (`--apply` is required to write).
- `--list` MAY scope the tick to one list.
- `--limit` MAY cap the number of contacts/chats processed (mirroring `tag-rules tick --limit`).

The tick MAY be registered as a cron job via `src/cron/runner.ts`. Default schedule SHOULD be `*/15 * * * *` as a safety net for missed reactive events. Operators MAY override per-list via `chat_reading_lists.metadata_json.cron` if present.

Periodic and reactive MUST be safe to run concurrently.

## Emitted Events

When the engine adds or removes a member, it MUST emit a NATS event:

```yaml
topic: ravi.chats.lists.member.added
payload:
  listId: string
  chatId: string
  contactId: string | null
  source: 'selector'
  cause:
    evaluation: 'reactive' | 'periodic' | 'manual'
    triggerEvent: 'ravi.tags.rule.applied' | 'tick' | string
    ruleId: string | null
  emittedAt: number (ms epoch)
```

```yaml
topic: ravi.chats.lists.member.removed
payload:
  listId: string
  chatId: string
  contactId: string | null
  source: 'selector'
  cause: { ... }
  emittedAt: number
```

Per-list and per-chat topics MAY also be emitted (`ravi.chats.lists.<listId>.member.*`, `ravi.chats.<chatId>.lists.member.*`) to enable filtered triggers, following the precedent of tag-rules emitting both global and per-asset topics.

Subscribers (observers, agents, audit consumers) MAY react. The engine MUST NOT subscribe to its own emitted events. There is exactly one allowed external trigger: `ravi.tags.rule.applied`.

## CLI Contract

```bash
# Create a dynamic reading list:
ravi chats lists create <name> \
  --mode dynamic \
  --selector '<json>' \
  [--metadata '<json>'] \
  [--owner <type:id>] \
  [--description <text>] \
  [--visibility private|team|system] \
  [--json]

# Update selector or metadata after create:
ravi chats lists set <list> selector '<json>'
ravi chats lists set <list> metadata '<json>'
ravi chats lists set <list> mode <static|dynamic|hybrid>

# Trigger evaluation:
ravi chats lists tick [--list <list>] [--apply] [--limit <n>] [--json]

# Dry-run evaluation against one target (returns trace):
ravi chats lists explain <list> [--target contact:<id>] [--target chat:<id>] [--json]
```

Contract requirements:

- `create` MUST validate the selector with the shared Zod schema. Invalid → fail fast with structured error.
- `set` MUST also validate. Setting `selector` on a list whose `mode` is `static` MAY be allowed but the engine MUST NOT act on it until `mode` becomes `dynamic` or `hybrid`.
- `tick` and `explain` MUST default to dry-run.
- `--apply` is required for any write.
- `explain` MUST return a trace structurally compatible with `tag-rules explain` for the same condition kinds, to enable shared debugging muscle memory.

## Performance

Reactive path performance:

- The reverse index `tag_slug → Set<list_id>` MUST be built at engine load time from parsed selectors and refreshed on selector mutation.
- Reactive evaluation on `ravi.tags.rule.applied` MUST consult the reverse index to bound work to affected lists. Full scans on tag events are disallowed.

Periodic path performance:

- `chats lists tick` is allowed to be O(L × C) where L = dynamic lists, C = eligible contacts. The `--limit` flag MUST be respected.
- Target: ≤2 seconds for 1000 contacts × 10 lists on commodity hardware in apply mode.
- The engine MUST NOT re-implement message scanning. Message-touching conditions (`any-message-text-matches`, `last-inbound-age` on chat scope) already paginate inside `src/tag-rules/conditions.ts` — the selector engine MUST call into those same evaluators.

## Concurrency and Idempotency

- Two concurrent ticks against the same state MUST produce zero duplicate active members.
- Reactive and periodic running simultaneously MUST converge.
- INSERT operations MUST use `INSERT ... ON CONFLICT DO NOTHING` (or equivalent) keyed on `idx_chat_reading_list_members_active`.
- UPDATE of `removed_at` MUST be a single statement (no read-then-write race).
- Reactive evaluation MUST debounce per (list, target) pair within a short window (suggested 500ms) to avoid thrashing under tag-rule cascades.
- A second tick of the same selector against the same state MUST report zero applied changes (idempotency check).

## Audit Trail

Every membership transition MUST leave audit:

- `chat_reading_list_members.source` records origin (`'selector'`).
- `chat_reading_list_members.metadata_json` SHOULD include `{ cause: { ruleId?, evaluation, triggerEvent }, listSnapshot: { selectorHash, version } }` to support forensic replay.
- Emitted NATS events form the secondary stream for cross-system audit consumers.
- Soft-delete (`removed_at`) preserves the timeline of membership transitions per pair.

## Permissions

The engine inherits the permission model of the underlying list (visibility scope) and chats (chat-level permissions). Selector evaluation MUST NOT bypass chat/contact/CRM permissions when materializing membership.

A selector that would match a chat the list owner cannot read SHOULD be skipped at evaluation time and the skip MUST be recorded with cause `permission_denied`. The tick MUST NOT fail wholesale due to per-target permission denial.

## Failure Modes

The engine MUST handle:

- **Invalid stored selector** (corrupt JSON, schema mismatch): log error, skip list for that cycle, emit `ravi.chats.lists.engine.error` for visibility. Do not crash the tick.
- **Missing contact / chat referenced in cursor or member**: cursor untouched, member transitioned to `removed_at = now()` with cause `target_missing`.
- **NATS unavailable**: reactive path degrades silently; periodic tick remains the source of truth.
- **DB constraint violation**: caught, logged, target skipped for this cycle. Counter recorded.

## Acceptance Criteria

The implementation is not complete until:

- A dynamic list with `selector: { scope: contact, match: all, conditions: [{ kind: has-tag, tag: X }] }` automatically gains and loses chats as contacts gain and lose tag X.
- Membership transitions are visible in `chat_reading_list_members` with correct `source = 'selector'` and `removed_at` semantics matching the state machine.
- Cursors per reader survive entry / exit / re-entry without reset.
- The engine NEVER mutates tags. Inspection of code AND runtime trace confirms one-way dependency from tag-rules to engine.
- Reactive evaluation is bounded by the reverse index. Full scans on `ravi.tags.rule.applied` are disallowed and a test asserts this.
- Periodic tick respects `--apply` (default dry-run) and `--limit`.
- All conditions valid for tag-rules contact scope are valid for selectors with `scope: contact`. Same for chat scope.
- `chats lists tick` is idempotent: two consecutive ticks against the same state produce zero applied changes.
- Concurrent ticks (validated under integration test) produce zero duplicate active members.
- `chats lists explain` returns a trace structurally identical to `tag-rules explain` for matching condition kinds.
- All existing tests in `src/tag-rules/engine.test.ts` continue to pass unchanged. The engine module integrates without modifying tag-rules code.

## Out of Scope (MVP)

Explicit non-goals for this spec, deferred to follow-up specs:

- `match: any` (OR) at top level — MVP is `all` only.
- Nested OR / NOT trees in selectors — MVP is flat AND.
- `hybrid` mode beyond simple UNION (advanced merge strategies).
- Pre-materialization of large dynamic lists for fast cursor queries.
- Selector versioning / migration tooling (selector schema evolution).
- Per-reader selector overrides (a reader sees a different filtered slice).
- Computed selector fields (e.g., "in the top N by activity") — restricted to declarative state queries.

These MAY be addressed by extending this spec or by new sub-specs once MVP is in production and need is empirically demonstrated.
