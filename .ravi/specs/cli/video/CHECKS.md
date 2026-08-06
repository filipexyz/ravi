# Video agent-first CLI contract / CHECKS

## Checks

- `video analyze <url> --json` (default `auto` strategy) MUST exit 3 with
  `dryRun: true`, a `plan` containing `paidPath` and `freeAlternative`, and
  MUST NOT call `analyzeVideo`.
- `video analyze <url> --force-analyze --json` MUST exit 3 with
  `plan.strategy: "gemini"` and the Gemini model in the plan.
- `video analyze <url> --strategy subtitles --json` MUST run without
  `--execute` and MUST invoke the subtitles strategy only.
- `video analyze <url> --strategy gemini --json --execute` MUST perform the
  paid analysis.
- An invalid `--strategy` value MUST fail with exit 1 BEFORE any brake output.
- `bun test src/cli/commands/video.test.ts` SHOULD pass after any change to the
  video contract surface.
