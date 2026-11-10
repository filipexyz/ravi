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
  renderer. Secret-shaped fixtures MUST be replaced with field markers
  without removing the surrounding reason. No arbitrary properties,
  headers/body/PII or stack may appear in the envelope, logger or trace.
- Provider wrapper tests MUST verify that the original throwable survives
  internally and that known credential values are supplied to deferred egress
  redaction. They must not require destructive sanitization at the throw site.
- The CLI constructor requires cause/context for missing-file and provider
  failures. An APIError containing a serialized body must retain declared
  reason/code while dropping the body and its private values.
- Run `bun test src/cli/error-egress-corpus.test.ts` for the global 14-vector,
  nine-sink regression proof, including mocked Slack chat delivery and the
  TypeScript SDK. Swift/Dart decoding tests do not prove native redactor parity.
- `bun test src/transcribe/error-context.test.ts` MUST verify the provider
  boundary with mocked OpenAI/Groq requests, without network calls.
- `bun test src/cli/commands/transcribe.test.ts` SHOULD pass after any change
  to the transcribe contract surface.
