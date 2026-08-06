---
id: cli/stickers
title: "Stickers agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - stickers
tags:
  - cli
  - stickers
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
applies_to:
  - src/cli/commands/stickers.ts
  - src/stickers/catalog.ts
  - src/stickers/send.ts
  - src/stickers/prompt.ts
  - src/cli/commands/sessions.ts
  - src/cli/agent-contract.ts
  - src/plugins/internal/ravi-system/skills/stickers/SKILL.md
owners:
  - ravi-dev
status: active
normative: true
---
# Stickers agent-first CLI contract

## Intent

Make `ravi stickers` reliable for agent consumers under the agent-first
contract defined by `cli/crm`: typed error envelopes, the 0/1/2/3 exit
taxonomy, a write brake on `send` (reaches a live chat) and `remove`
(destructive catalog deletion), plus `STICKER_NOT_FOUND` with local-catalog
suggestions and compact `--fields` on `list`.

## Invariants

1. With `--json`, every failure on a migrated op MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?}}`.
2. `stickers send` MUST default to dry-run and require `--execute`; the
   dry-run MUST exit 3 with `dryRun: true` and a `plan` (sticker id/label,
   resolved target, filename/mime) and MUST NOT emit `ravi.stickers.send`.
3. `stickers remove` MUST default to dry-run and require `--execute`; on exit 3
   the sticker MUST still exist in the catalog.
4. `stickers show`, `stickers remove` and `stickers send` on an unknown id
   MUST exit 1 with `STICKER_NOT_FOUND` and up to 3 `suggestions` drawn from
   the LOCAL catalog (ids and labels).
5. Validation MUST run BEFORE the brake on `send`: unknown sticker (exit 1),
   missing media file (`STICKER_MEDIA_NOT_FOUND`, exit 1), target resolution
   and the channel-capability / enabled / allowlist checks (legacy throws) all
   precede the dry-run plan.
6. `stickers add` keeps immediate execution (declared unbraked: local catalog
   config, reversible with `remove`, no live channel involved).
7. `stickers list` MUST accept `--fields a,b,c`, narrowing both `items` and
   `stickers` arrays.
8. When invoked from an agent context (`RAVI_*` envs present), a thrown
   `ContractError` MUST preserve its exit code through the registry dispatcher.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| send | external delivery to a live chat (high) | dry-run + `--execute` |
| remove | destructive catalog deletion, no undo | dry-run + `--execute` |
| add | reversible local config | not braked (declared) |
| list / show | reads | not braked |

## Official error cases

| case | code | exit |
|---|---|---|
| sticker not found | `STICKER_NOT_FOUND` + suggestions | 1 |
| sticker media file missing | `STICKER_MEDIA_NOT_FOUND` | 1 |
| braked write without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |

## Internal consumers

- `src/cli/commands/sessions.ts` (`buildCurrentSessionStickerSendCommand` and
  the `sendSticker` usage hint) MUST teach
  `ravi stickers send <sticker-id> --execute`.
- `src/stickers/prompt.ts` injects the sticker section into live agent
  prompts and MUST teach `ravi stickers send <id> --execute`.
- The `stickers` skill MUST document `--execute` on send/remove examples.

## Known gaps

- Parser-level usage errors (exit 2 + `acceptedFlags`) depend on registering
  `stickers` in `AGENT_CONTRACT_DOMAINS` (`src/cli/index.ts`), out of scope
  for this migration batch.

## Validation

- `bun test src/cli/commands/stickers.test.ts` green (the `stickers contract`
  block included).
- Live checks: `ravi stickers send wave --json` → exit 3 + plan; `--execute`
  emits; `ravi stickers send wav --json` → `STICKER_NOT_FOUND` + suggestions;
  `ravi stickers remove wave --json` → exit 3 and the sticker still listed;
  `ravi stickers list --json --fields id,enabled` narrows.

## Known Failure Modes

- `buildStickerSendEvent` performs capability/enabled/allowlist validation AND
  builds the event; running it before the brake is what keeps validation ahead
  of the plan — moving the brake above it would show plans for sends that can
  never happen (e.g. Matrix channels).
- The live-agent prompt (`stickers/prompt.ts`) and the sessions hints teach
  this command verbatim; forgetting `--execute` there puts agents in an exit-3
  loop where they believe stickers were sent.
