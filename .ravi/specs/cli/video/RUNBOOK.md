# Video agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/video --mode rules --json`.
2. Reproduce with `--json` and read `error.code` first.
3. Exit `1` with `Invalid video analysis strategy`: use `auto`, `subtitles` or
   `gemini`.
4. Subtitles path failing on a local file: expected — local files require a
   strategy that can use Gemini.

## Validation

```bash
bun test src/cli/commands/video.test.ts
```

Live checks:

```bash
ravi video analyze "https://youtu.be/ID" --json                        # runs direct
ravi video analyze "https://youtu.be/ID" --strategy subtitles --json   # prohibits Gemini fallback
ravi video analyze "https://youtu.be/ID" --strategy gemini --json      # runs Gemini directly
```
