# Transcribe agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/transcribe --mode rules --json`.
2. Reproduce with `--json` and read `error.code` first.
3. Exit `1` unsupported format: convert to one of the supported extensions
   (`.ogg`, `.opus`, `.mp3`, `.m4a`, `.mp4`, `.wav`, `.webm`).
4. Exit `1` + `FILE_NOT_FOUND`: the path must exist locally on the machine
   running the CLI.
5. Exit `1` + `TRANSCRIBE_FAILED`: check `OPENAI_API_KEY` in `~/.ravi/.env`
   and retry — the envelope is retryable.

## Validation

```bash
bun test src/cli/commands/transcribe.test.ts
```

Live checks:

```bash
ravi transcribe file /tmp/audio.mp3 --json             # transcribes directly
ravi transcribe file /tmp/nope.mp3 --json              # expect exit 1 + FILE_NOT_FOUND
```
