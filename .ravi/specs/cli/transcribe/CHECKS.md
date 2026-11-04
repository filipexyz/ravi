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
- Provider error tests MUST verify that the original reason, provider, model,
  HTTP status/code and file survive through the final JSON envelope and text
  renderer. A real secret-shaped fixture MUST be replaced with `[redacted]`
  without removing the surrounding reason.
- `bun test src/transcribe/error-context.test.ts` MUST verify the provider
  boundary with mocked OpenAI/Groq requests, without network calls.
- `bun test src/cli/commands/transcribe.test.ts` SHOULD pass after any change
  to the transcribe contract surface.
