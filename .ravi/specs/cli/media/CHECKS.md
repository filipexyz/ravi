# Media agent-first CLI contract / CHECKS

## Checks

- `media send <file> --json` without `--execute` MUST exit 3, MUST report
  `dryRun: true` with a minimal plan carrying `fileName`, `mimeType`,
  `mediaType`, `captionPresent`, `voiceNote` and target channel/account plus
  chat/thread presence flags. It MUST NOT expose the resolved path, caption or
  personal target IDs, and MUST NOT call the omni CLI or the Slack native
  sender.
- `media send <file> --json --execute` MUST perform the delivery and return the
  typed success payload.
- `media send /path/that/does/not/exist --json` MUST exit 1 with the
  `FILE_NOT_FOUND` envelope BEFORE any brake output.
- A delivery failure after `--execute` MUST exit 1 with `MEDIA_SEND_FAILED` and
  `retryable: true` in the envelope.
- The sessions builder `buildCurrentSessionMediaSendCommand` MUST render
  `ravi media send "<file-path>" --execute`.
- The `sendCommand` field returned by `image generate` and `audio generate`
  MUST include `--execute`.
- `bun test src/cli/commands/media-json.test.ts` SHOULD pass after any change
  to the media contract surface.
