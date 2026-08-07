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
  - external-api-cost
applies_to:
  - src/cli/commands/video.ts
  - src/plugins/internal/ravi-system/skills/video/SKILL.md
owners:
  - ravi-dev
status: active
normative: true
---
# Video agent-first CLI contract

## Intent

Make `ravi video` reliable for agent consumers under the agent-first contract
defined by `cli`. The subtitles path is free while Gemini may be billed, but
the CLI has no configured cost limit or reliable preflight estimate. Analysis
has no external delivery or destructive effect, so every strategy runs
immediately.

## Invariants

1. `video analyze` with `auto`, `subtitles` or `gemini` (including
   `--force-analyze`) MUST run without `--execute`.
2. `--strategy subtitles` MUST continue to prevent Gemini fallback.
3. Strategy validation (`Invalid video analysis strategy`) MUST fail before the
   analysis call with `USAGE_ERROR` (exit 2).

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| analyze (auto / gemini / --force-analyze) | routine processing; may use Gemini | not braked |
| analyze --strategy subtitles | free captions path | not braked |

## Official error cases

| case | code | exit |
|---|---|---|
| invalid strategy | `USAGE_ERROR` + accepted values | 2 |

## Internal consumers

- The `video` skill (`src/plugins/internal/ravi-system/skills/video/SKILL.md`)
  MUST document the free `--strategy subtitles` path and MUST NOT require
  `--execute` for analysis examples.

## Known gaps

- Parser-level usage errors use the global exit-2 `USAGE_ERROR` envelope because
  `video` is registered in `AGENT_CONTRACT_DOMAINS` (`src/cli/index.ts`).

## Validation

- `bun test src/cli/commands/video.test.ts` green.
- Live checks: `ravi video analyze <url> --json`, `--strategy subtitles` and
  `--force-analyze` all run directly; invalid strategy exits 1.

## Known Failure Modes

- `analyzeVideo` decides the Gemini fallback internally. `--strategy subtitles`
  remains the explicit way to prohibit that fallback when cost avoidance is
  more important than completing the analysis.
