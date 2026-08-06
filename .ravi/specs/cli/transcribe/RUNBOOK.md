# Transcribe agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/transcribe --mode rules --json`.
2. Reproduce with `--json` and read `error.code` first.
3. Exit `3`: read `error.plan` — `sizeMB` is the billing driver. Confirm and
   re-run with `--execute`.
4. Exit `1` unsupported format: convert to one of the supported extensions
   (`.ogg`, `.opus`, `.mp3`, `.m4a`, `.mp4`, `.wav`, `.webm`).
5. Exit `1` + `FILE_NOT_FOUND`: the path must exist locally on the machine
   running the CLI.
6. Exit `1` + `TRANSCRIBE_FAILED`: check `OPENAI_API_KEY` in `~/.ravi/.env`
   and retry — the envelope is retryable.
7. If a transcription billed without `--execute`, the brake regressed: check
   that `contractDryRun` runs before `transcribeFile` in
   `src/cli/commands/transcribe.ts`.

## Validation

```bash
bun test src/cli/commands/transcribe.test.ts
```

Live checks:

```bash
ravi transcribe file /tmp/audio.mp3 --json             # expect exit 3 + plan
ravi transcribe file /tmp/audio.mp3 --json --execute   # bills Whisper
ravi transcribe file /tmp/nope.mp3 --json              # expect exit 1 + FILE_NOT_FOUND
```
