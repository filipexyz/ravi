---
id: cli/image
title: "Image agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - image
tags:
  - cli
  - image
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
  - external-api-cost
applies_to:
  - src/cli/commands/image.ts
  - src/cli/agent-contract.ts
  - src/plugins/internal/ravi-system/skills/image/SKILL.md
owners:
  - ravi-dev
status: active
normative: true
---
# Image agent-first CLI contract

## Intent

Make `ravi image` reliable for agent consumers under the agent-first contract
defined by `cli`. Generation and local atlas splitting run immediately because
the CLI has no configured cost limit or reliable preflight estimate. Delivery
to a live chat is braked, whether requested explicitly with `--send` or implied
by an origin chat on `image generate`.

## Invariants

1. `image generate` without delivery MUST run without `--execute`. When
   delivery is explicit or implied by an origin chat, it MUST require
   `--execute` and show resolved generation/delivery facts in the plan. The
   plan MUST expose only `promptChars` and `captionPresent`, never prompt or
   caption bytes.
2. A delivery brake MUST run BEFORE any side effect: no artifact record is
   created, no background worker is spawned and no provider is called on exit 3.
3. An internal async worker MUST carry `--execute` only when it inherits an
   approved delivery; generation-only workers do not need the flag.
4. Provider resolution/validation (no provider configured, `--async`+`--sync`
   conflict, reserved `--artifact-id`), local source/input validation and
   delivery-target resolution MUST fail BEFORE the brake. A missing provider
   MUST use the canonical JSON envelope in JSON mode; remaining legacy
   validation paths keep their current text messages and exit 1.
5. `image atlas split` without `--send` keeps immediate execution. With
   `--send`, it MUST require `--execute` before splitting, artifact creation or
   media delivery; the plan exposes `captionPresent`, never the caption body.
6. The `sendCommand` field in the generate payload MUST teach
   `ravi media send "<path>" --execute`.
7. When invoked from an agent context (`RAVI_*` envs present), a thrown
   `ContractError` MUST preserve its exit code through the registry dispatcher.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| generate without delivery | generation + local artifact persistence | not braked |
| generate with explicit/implicit delivery | external chat delivery | dry-run + `--execute` |
| atlas split without `--send` | local derive/artifact persistence | not braked |
| atlas split with `--send` | external chat delivery | dry-run + `--execute` |

## Official error cases

| case | code | exit |
|---|---|---|
| no provider configured | `IMAGE_PROVIDER_NOT_CONFIGURED` | 1 |
| flag conflicts | legacy text (validation) | 1 |
| generate delivery or atlas `--send` without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |

## Internal consumers

- The `image` skill (`src/plugins/internal/ravi-system/skills/image/SKILL.md`)
  MUST document `--execute` only on examples that deliver externally.
- The generate payload's `sendCommand` and text hint teach `ravi media send`
  and MUST carry `--execute` (see `cli/media`).

## Known gaps

- Parser-level usage errors use the global exit-2 `USAGE_ERROR` envelope because
  `image` is registered in `AGENT_CONTRACT_DOMAINS` (`src/cli/index.ts`).

## Validation

- `bun test src/cli/commands/image-contract.test.ts` and
  `bun test src/cli/commands/image.test.ts` green.
- Live checks: `ravi image generate "gato" --json` queues immediately when no
  origin chat exists; `--send` without `--execute` exits 3 before provider and
  artifacts; `ravi artifacts events <id>` shows the worker lifecycle.

## Known Failure Modes

- The async path creates the artifact and spawns the worker before any provider
  call. For delivery runs, the conditional brake must remain before both.
- The spawned worker re-enters `image generate`; approved delivery workers must
  inherit `--execute`, while generation-only workers must not depend on it.
