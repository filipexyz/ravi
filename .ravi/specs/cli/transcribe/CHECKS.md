# Transcribe agent-first CLI contract / CHECKS

## Checks

- `transcribe file <audio> --json` without `--execute` MUST exit 3 with
  `dryRun: true` and a `plan` showing mimeType, sizeBytes and lang, and MUST
  NOT call the Whisper service.
- `transcribe file <audio> --json --execute` MUST perform the paid
  transcription and return the typed payload.
- An unsupported extension MUST fail with exit 1 (legacy `Unsupported audio
  format` message) BEFORE any brake output.
- A missing file with a supported extension MUST exit 1 with the
  `FILE_NOT_FOUND` envelope BEFORE any brake output.
- A provider failure after `--execute` MUST exit 1 with `TRANSCRIBE_FAILED`
  and `retryable: true`.
- `bun test src/cli/commands/transcribe.test.ts` SHOULD pass after any change
  to the transcribe contract surface.
