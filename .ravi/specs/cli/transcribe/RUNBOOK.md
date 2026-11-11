# Transcribe agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/transcribe --mode rules --json`.
2. Reproduce with `--json` and read `error.code` first.
3. Exit `1` unsupported format: convert to one of the supported extensions
   (`.ogg`, `.opus`, `.mp3`, `.m4a`, `.mp4`, `.wav`, `.webm`).
4. Exit `1` + `FILE_NOT_FOUND`: the path must exist locally on the machine
   running the CLI.
5. Exit `1` + `TRANSCRIBE_FAILED`: inspect `error.cause` and typed
   provider/model/status/code context before deciding whether the failure is
   credential, unsupported input, quota or provider availability. HTTP status
   alone does not establish the reason. Check credential configuration without
   printing its value; retry only after addressing the reported cause.
6. If the reason is missing, follow the original throwable through the provider
   wrapper to the CLI diagnostic constructor. If a secret appears, add a
   synthetic corpus row and fix the shared egress redactor or ingress
   projection. Do not dump raw errors, stacks, audio bytes or provider bodies
   into logs or trace artifacts.

## Validation

```bash
bun test src/cli/commands/transcribe.test.ts
bun test src/transcribe/error-context.test.ts
bun test src/cli/error-egress-corpus.test.ts
bun scripts/error-cause-scan.ts
```

Live checks:

```bash
ravi transcribe file /tmp/audio.mp3 --json             # transcribes directly
ravi transcribe file /tmp/nope.mp3 --json              # expect exit 1 + FILE_NOT_FOUND
```
