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
  `retryable: true` in the envelope, except Omni `401` / `Invalid API key`
  which MUST exit 1 with `OMNI_AUTH_FAILED`, `retryable: false`, and a
  `suggestedAction` that names the `servers.list.<active>.apiKey` vs
  top-level / `OMNI_API_KEY` divergence without echoing the key.
- Isolated remote `media send` failures with `MEDIA_SEND_FAILED`,
  `OMNI_AUTH_FAILED`, or `FILE_NOT_FOUND` MUST keep the code and replace the
  remote message / `suggestedAction` with the local catalog copy. Generic
  `COMMAND_FAILED` MUST stay `Remote command failed.` Remote text, keys, and
  URLs MUST be absent. The same catalog code on another `op` MUST NOT receive
  media copy.
- `media send --execute` MUST authenticate the spawned Omni CLI with the same
  `apiUrl`/`apiKey` `resolveOmniConnection()` would give the Ravi Omni client,
  including writing that key into `servers.list.default` via `OMNI_CONFIG_DIR`
  so a stale server entry cannot win.
- The sessions builder `buildCurrentSessionMediaSendCommand` MUST render
  `ravi media send "<file-path>" --execute`.
- The `sendCommand` field returned by `image generate` and `audio generate`
  MUST include `--execute`.
- `bun test src/cli/commands/media-json.test.ts src/cli/media-send.test.ts src/cli/media-send-auth.test.ts src/cli/media-send-access.test.ts src/cli/remote-gateway.test.ts src/omni-config.test.ts`
  SHOULD pass after any change to the media contract, Omni CLI auth wiring, or
  isolated remote projection.
