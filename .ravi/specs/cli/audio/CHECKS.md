# Audio agent-first CLI contract / CHECKS

## Checks

- `audio generate "<texto>" --json` MUST generate without `--execute` and MUST
  NOT call the media sender.
- `audio generate "<texto>" --send --json` without `--execute` MUST exit 3
  before both ElevenLabs and the media sender; adding `--execute` MUST generate
  and deliver.
- Generate and TTS dry-run plans MUST expose only text length and
  `captionPresent`; secret markers at the beginning or end of text/caption MUST
  NOT appear in the envelope.
- `audio tts "<texto>" --json` without `--execute` MUST exit 3 and MUST NOT
  emit `ravi.tts`; with `--execute` the emit MUST happen. This brake protects
  triggered downstream work/playback, not cost without a configured threshold.
- Text validation (`Provide text or --text-file.`, unsafe `--text-file` paths)
  and a missing delivery target MUST fail with exit 1 before generation or
  confirmation output.
- `audio voices --json --fields a,b` MUST narrow each voice object to the
  requested fields; `audio pending --json --fields a,b` MUST narrow each item.
- `audio blob <id>` MUST keep returning raw bytes on success; a missing blob
  MUST exit 1 as `RESOURCE_NOT_FOUND` in every transport without forwarding
  the binary response body.
- `bun test src/cli/commands/media-json.test.ts` SHOULD pass after any change
  to the audio contract surface.
