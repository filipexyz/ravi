---
id: cli/react
title: "React agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - react
tags:
  - cli
  - react
  - reactions
  - agent-first
  - error-envelope
  - exit-taxonomy
  - unbraked-by-design
applies_to:
  - src/cli/commands/react.ts
  - src/cli/commands/sessions.ts
  - src/cli/agent-contract.ts
owners:
  - ravi-dev
status: active
normative: true
---
# React agent-first CLI contract

## Intent

Make `ravi react` reliable for agent consumers under the agent-first contract
defined by `cli`. The domain's single op, `react send`, is DECLARED
UNBRAKED: an emoji reaction is trivially reversible (WhatsApp replaces a
reaction with the next one and removes it with an empty reaction; the Slack
chat_action contract has an explicit remove operation), and it is the surface
the sessions hints recommend precisely as the lightweight alternative to a
text reply. The contract work here is the error side: typed envelopes for
missing context and unknown messages.

## Invariants

1. `react send` MUST perform immediately, WITHOUT `--execute` — unbraked by
   design, with the reversibility rationale documented in the command source.
2. With `--json`, every failure MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?}}`.
3. Without a channel source context, `react send` MUST exit 1 with
   `NO_CHANNEL_CONTEXT`.
4. When the current chat IS known to the local chat ledger and the message id
   resolves to nothing there (neither `providerMessageId` nor canonical cm id),
   `react send` MUST exit 1 with `MESSAGE_NOT_FOUND` and up to 3 `suggestions`
   of real recent provider message ids from that chat — BEFORE any emit.
5. When the current chat is NOT in the local ledger, validation MUST fail open
   (the reaction is emitted): an unmatched reaction is harmless and reversible,
   and a false not-found would block legitimate reactions on unledgered chats.
6. Slack reactions without a canonical chat target MUST exit 1 with
   `INVALID_TARGET`.
7. When invoked from an agent context (`RAVI_*` envs present), a thrown
   `ContractError` MUST preserve its exit code through the registry dispatcher.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| send | trivially reversible channel action (replace/remove exists) | not braked (declared, rationale in source) |

## Official error cases

| case | code | exit |
|---|---|---|
| no channel context | `NO_CHANNEL_CONTEXT` | 1 |
| message unknown to a ledgered chat | `MESSAGE_NOT_FOUND` + suggestions | 1 |
| Slack without canonical chat target | `INVALID_TARGET` | 1 |

## Internal consumers

- `src/cli/commands/sessions.ts` (`buildCurrentSessionReactionCommand` and the
  `reactMessage` usage hint) teaches `ravi react send <message-id> <emoji>` —
  correctly WITHOUT `--execute`, matching the unbraked verdict.
- The workspace `AGENTS.md` teaches `ravi react send ABC123XYZ 👍` — also
  correct as-is; no change was needed because the op is unbraked.

## Known gaps

- SKILL GAP: there is no `react` skill under
  `src/plugins/internal/ravi-system/skills/`; the surface is taught through
  the sessions hints, the stickers skill (response-surface list) and AGENTS.md.
- Parser-level usage errors use the global exit-2 `USAGE_ERROR` envelope because
  `react` is registered in `AGENT_CONTRACT_DOMAINS` (`src/cli/index.ts`).

## Validation

- `bun test src/cli/commands/media-json.test.ts` green (the `react send
  contract` block included).
- Live checks: `ravi react send <mid> 👍 --json` from a routed session emits;
  a bogus mid in a ledgered chat → `MESSAGE_NOT_FOUND` + suggestions; from a
  contextless shell → `NO_CHANNEL_CONTEXT`.

## Known Failure Modes

- The MESSAGE_NOT_FOUND gate must stay fail-open on unledgered chats: the chat
  ledger does not cover every historical surface, and a strict gate would turn
  ledger gaps into false reaction failures.
- The ledger lookup keys on `source.instanceId ?? accountId`; channels whose
  context carries only the account alias rely on that fallback matching the
  ledger's instance column — a mismatch degrades to fail-open, never to a
  false MESSAGE_NOT_FOUND.
