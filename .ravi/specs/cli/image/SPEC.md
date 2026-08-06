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
defined by `cli`. `image generate` spends EXTERNAL API money (OpenAI /
Gemini image models) on every call, so it is the braked op: dry-run by default
showing exactly which provider/model/size would be billed. `image atlas split`
is a local ImageMagick operation and stays unbraked.

## Invariants

1. `image generate` MUST default to dry-run and require `--execute`; the
   dry-run MUST exit 3 with `dryRun: true` and a `plan` carrying the RESOLVED
   provider, model, mode, aspect, size, quality, format, compression,
   background, source, outputDir, async and send — the money-relevant facts.
2. The brake MUST run BEFORE any side effect: no artifact record is created, no
   background worker is spawned and no provider is called on exit 3.
3. The internal async worker re-invocation MUST carry `--execute` (workers are
   spawned only after an approved run; they never re-hit the brake).
4. Provider resolution/validation (no provider configured, `--async`+`--sync`
   conflict, reserved `--artifact-id`) MUST fail BEFORE the brake with the
   legacy messages (exit 1).
5. `image atlas split` keeps immediate execution (local read/derive op,
   declared unbraked); its optional `--send` remains an explicit opt-in flag.
6. The `sendCommand` field in the generate payload MUST teach
   `ravi media send "<path>" --execute`.
7. When invoked from an agent context (`RAVI_*` envs present), a thrown
   `ContractError` MUST preserve its exit code through the registry dispatcher.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| generate | external API money (high) | dry-run + `--execute` |
| atlas split | local derive/read; `--send` is explicit opt-in | not braked (declared) |

## Official error cases

| case | code | exit |
|---|---|---|
| no provider configured / flag conflicts | legacy text (validation) | 1 |
| braked generate without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |

## Internal consumers

- The `image` skill (`src/plugins/internal/ravi-system/skills/image/SKILL.md`)
  MUST document `--execute` on every generate example.
- The generate payload's `sendCommand` and text hint teach `ravi media send`
  and MUST carry `--execute` (see `cli/media`).

## Known gaps

- Parser-level usage errors use the global exit-2 `USAGE_ERROR` envelope because
  `image` is registered in `AGENT_CONTRACT_DOMAINS` (`src/cli/index.ts`).

## Validation

- `bun test src/cli/commands/image-contract.test.ts` and
  `bun test src/cli/commands/image.test.ts` green.
- Live checks: `ravi image generate "gato" --json` → exit 3 + plan with
  provider/model; `--execute` queues the async artifact; `ravi artifacts events
  <id>` shows the worker started.

## Known Failure Modes

- The async path creates the artifact and spawns the worker BEFORE any
  provider call — a brake placed after `createArtifact` would leak pending
  artifact records on every dry-run. The brake sits before both.
- The spawned worker re-enters `image generate`; without `--execute` appended
  to `workerArgs` the worker itself would exit 3 and the artifact would hang in
  `pending` forever.
