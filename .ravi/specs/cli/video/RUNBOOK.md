# Video agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/video --mode rules --json`.
2. Reproduce with `--json` and read `error.code` first.
3. Exit `3`: read `error.plan`. If the video is a public YouTube URL and a
   transcript is enough, use the `freeAlternative`
   (`--strategy subtitles`) — no `--execute`, no billing. Otherwise re-run
   with `--execute`.
4. Exit `1` with `Invalid video analysis strategy`: use `auto`, `subtitles` or
   `gemini`.
5. Subtitles path failing on a local file: expected — local files always go
   through Gemini; use `--execute`.
6. If an `auto`/`gemini` analysis ran without `--execute`, the brake regressed:
   check the `requestedStrategy !== "subtitles"` guard before `analyzeVideo`
   in `src/cli/commands/video.ts`.

## Validation

```bash
bun test src/cli/commands/video.test.ts
```

Live checks:

```bash
ravi video analyze "https://youtu.be/ID" --json                       # expect exit 3 + plan
ravi video analyze "https://youtu.be/ID" --strategy subtitles --json  # free, runs direct
ravi video analyze "https://youtu.be/ID" --strategy gemini --json --execute  # bills Gemini
```
