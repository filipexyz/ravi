# Transcribe agent-first CLI contract / CHECKS

## Checks

- `transcribe file <audio> --json` MUST call the transcription service and
  return the typed payload without `--execute`.
- An unsupported extension MUST fail with exit 1 (legacy `Unsupported audio
  format` message) before the provider call.
- A missing file with a supported extension MUST exit 1 with the
  `FILE_NOT_FOUND` envelope before the provider call.
- A provider failure MUST exit 1 with `TRANSCRIBE_FAILED`
  and `retryable: true`.
- `bun test src/cli/commands/transcribe.test.ts` SHOULD pass after any change
  to the transcribe contract surface.
