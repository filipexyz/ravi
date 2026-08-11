# Video agent-first CLI contract / CHECKS

## Checks

- `video analyze <url> --json` (default `auto`) MUST call `analyzeVideo`
  without `--execute`.
- `video analyze <url> --force-analyze --json` MUST run the Gemini strategy
  without `--execute`.
- `video analyze <url> --strategy subtitles --json` MUST run without
  `--execute` and MUST invoke the subtitles strategy only.
- `video analyze <url> --strategy gemini --json` MUST perform the analysis.
- An invalid `--strategy` value MUST fail with `USAGE_ERROR` and exit 2 before analysis.
- `bun test src/cli/commands/video.test.ts` SHOULD pass after any change to the
  video contract surface.
