---
id: cli/chats
title: "Chats agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - chats
tags:
  - cli
  - chats
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
applies_to:
  - src/cli/commands/chats.ts
  - src/cli/agent-contract.ts
  - .ravi/specs/channels/chats/reading-lists/SPEC.md
owners:
  - ravi-dev
status: active
normative: true
---
# Chats agent-first CLI contract

## Intent

Make `ravi chats` (and its `chats.messages` and `chats.lists` groups) reliable
for agent consumers under the agent-first contract defined by `cli`: typed
error envelopes, the 0/1/2/3 exit taxonomy, risk-proportional confirmation,
and compact discovery. Chats are the canonical read surface for conversations
and reading queues, so local membership and cursor edits stay immediate while
remaining authorized as mutations.

## Invariants

1. With `--json`, every failure on a migrated op MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedFlags?}}`.
2. Exit codes MUST follow the taxonomy: `0` success · `1` error (not-found /
   provider) · `2` usage error · `3` blocked by policy (write brake).
3. An unknown chat ref on `chats read` or on any `chats.lists` op that resolves
   a chat MUST exit 1 with `CHAT_NOT_FOUND` and up to 3 `suggestions` built from
   the same local `dbListChats` surface that `chats list` exposes.
4. An unknown reading-list ref MUST exit 1 with `READING_LIST_NOT_FOUND` and up
   to 3 `suggestions` from `dbListChatReadingLists`, honoring the same optional
   `--owner` filter the listing accepts. An unknown `--contact` filter on
   `chats list` MUST exit 1 with `CONTACT_NOT_FOUND` and MUST NOT carry
   suggestions: contacts enforce contactScope inside their own domain and chats
   cannot reproduce that visibility filter, so the envelope only points to
   `ravi contacts list`.
5. `chats lists remove` MUST run immediately without `--execute`: it only
   soft-deactivates a local membership, preserves cursor history, and can be
   reversed with `chats lists add`. It MUST remain `kind: "mutate"`.
6. Pre-existing default-dry-run ops keep their surface unchanged and count as
   brake equivalents: `chats backfill-provider-timestamps` only writes with
   `--apply` (its default run is the dry-run), and `chats lists recompute` is
   guarded by `chats lists preview` (read-only diff) plus the selector safety
   gate that blocks unsafe selectors before any write. Their flags MUST NOT be
   renamed to `--execute`.
7. `chats list`, `chats lists list`, and `chats lists members` MUST accept
   `--fields a,b,c` for compact output. The declared strict return schemas
   describe the full (non-projected) payload; `--fields` is a projection on top.
8. Unbraked writes (declared): `chats ensure` and `chats messages create` are
   idempotent by client id; `chats lists create`, `chats lists add`,
   `chats lists remove`, `chats lists mark-read`, and `chats lists delta
   --mark-read` are reversible. They keep immediate-write behavior.
9. When invoked from an agent context (`RAVI_*` envs present), a thrown
   `ContractError` MUST preserve its exit code through the registry dispatcher.
10. Without `--json`, error output keeps the legacy text path (exit 1), except
    braked writes which exit 3.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| lists remove | local soft-deactivation; cursor history retained; reversible by add | not braked |
| backfill-provider-timestamps | bulk timestamp rewrite | pre-existing `--apply` default-dry-run (equivalent; not renamed) |
| lists recompute | bulk membership materialization (can remove members) | pre-existing `preview` + selector safety gate (equivalent; not renamed) |
| ensure / messages create | idempotent by clientRequestId/clientMessageId | not braked (declared) |
| lists create / lists add | reversible config | not braked (declared) |
| lists mark-read / delta --mark-read | reversible cursor advance | not braked (declared) |

## Official error cases

| case | code | exit |
|---|---|---|
| chat not found | `CHAT_NOT_FOUND` + suggestions | 1 |
| reading list not found | `READING_LIST_NOT_FOUND` + suggestions | 1 |
| contact filter not found | `CONTACT_NOT_FOUND` (no suggestions, scoped) | 1 |
| invalid flag/arg | `USAGE_ERROR` + acceptedFlags | 2 |

## Internal consumers

There is NO dedicated `chats` skill in `src/plugins/internal/ravi-system/skills/`
— this is a registered gap of this wave. The surface is only taught incidentally
by read-only examples in the `contacts`, `observers`, `instances`, and
`tag-rules` skills (none teaches `lists remove`, so none needs `--execute`).
`.ravi/specs/channels/chats/reading-lists/SPEC.md` documents the CLI shape and
must keep `lists remove` free of an `--execute` requirement.

## Known gaps

- No dedicated `chats` skill exists to teach the surface (see Internal
  consumers).

## Validation

- `bun test src/cli/commands/chats.test.ts` green (contract block included), no
  new failures vs the `dev` baseline.
- Live checks on the local CLI (isolated `RAVI_STATE_DIR`): `chats read
  chat_ffffffffffffffffffffffff --json` → `CHAT_NOT_FOUND`, exit 1 with
  suggestions; `chats lists remove <list> <chat> --json` → exit 0 and the member
  inactive with cursor history retained; `chats list --json --fields
  messageCount` narrows items; `chats backfill-provider-timestamps --json`
  without `--apply` reports `dryRun: true` and writes nothing.

## Known Failure Modes

- `resolveReadingList` wraps its fallback lookup in try/catch and re-fails any
  caught error; a `ContractError` thrown by the not-found branch inside the try
  MUST be rethrown untouched or the envelope collapses into a plain `fail()`
  with exit 1.
- `chats messages` (compatibility command) delegates to `chats read`, so its
  not-found envelope reports `op: "chats read"` — consumers matching on `op`
  must accept that.
- The strict return schemas (`chatsListReturnSchema` etc.) describe the full
  payload; validating a `--fields`-projected payload against them fails by
  design. Compact mode is a projection, not a schema change.
