---
id: cli/video
title: "Video agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - video
tags:
  - cli
  - video
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
  - external-api-cost
applies_to:
  - src/cli/commands/video.ts
  - src/cli/agent-contract.ts
  - src/plugins/internal/ravi-system/skills/video/SKILL.md
owners:
  - ravi-dev
status: active
normative: true
---
# Video agent-first CLI contract

## Intent

Make `ravi video` reliable for agent consumers under the agent-first contract
defined by `cli`. `video analyze` has a split personality: the subtitles
path (yt-dlp captions) is free and local, while the Gemini path is paid
EXTERNAL API money. The brake follows the money: any run that may reach Gemini
(`--strategy gemini`, `--force-analyze`, the `auto` default and local files) is
braked; the explicit `--strategy subtitles` run is guaranteed free and stays
immediate.

## Invariants

1. `video analyze` with strategy `auto` or `gemini` (including
   `--force-analyze`) MUST default to dry-run and require `--execute`; the
   dry-run MUST exit 3 with `dryRun: true` and a `plan` showing the url,
   strategy, `paidPath` (`gemini` or `gemini-fallback-possible`), the Gemini
   model that would be billed, and the `freeAlternative` command.
2. `video analyze --strategy subtitles` MUST run WITHOUT `--execute` — it is
   the free/local path and never calls Gemini.
3. Strategy validation (`Invalid video analysis strategy`) MUST fail BEFORE the
   brake (exit 1).
4. When invoked from an agent context (`RAVI_*` envs present), a thrown
   `ContractError` MUST preserve its exit code through the registry dispatcher.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| analyze (auto / gemini / --force-analyze) | may bill external Gemini API | dry-run + `--execute` |
| analyze --strategy subtitles | free local captions path | not braked (declared) |

## Official error cases

| case | code | exit |
|---|---|---|
| invalid strategy | legacy text (validation) | 1 |
| braked analyze without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |

## Internal consumers

- The `video` skill (`src/plugins/internal/ravi-system/skills/video/SKILL.md`)
  MUST document the free `--strategy subtitles` path and `--execute` on the
  paid examples.

## Known gaps

- Parser-level usage errors use the global exit-2 `USAGE_ERROR` envelope because
  `video` is registered in `AGENT_CONTRACT_DOMAINS` (`src/cli/index.ts`).

## Validation

- `bun test src/cli/commands/video.test.ts` green.
- Live checks: `ravi video analyze <url> --json` → exit 3 + plan with
  `freeAlternative`; `--strategy subtitles` runs directly; `--force-analyze
  --execute` bills Gemini.

## Known Failure Modes

- `analyzeVideo` decides the Gemini fallback INTERNALLY (no subtitles found,
  extraction failure, local file), so a CLI-level brake keyed only on
  `--strategy gemini` would leak paid calls through `auto`. The brake keys on
  "not guaranteed free" instead.
- `auto` on a YouTube video WITH subtitles is free in practice but still braked
  — the CLI cannot know before running. The plan's `freeAlternative` teaches
  the zero-cost escape hatch.
