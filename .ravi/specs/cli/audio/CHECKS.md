# Audio agent-first CLI contract / CHECKS

## Checks

- `audio generate "<texto>" --json` without `--execute` MUST exit 3 with
  `dryRun: true` and a `plan` showing the resolved voice/model/speed/lang plus
  text preview and character count, and MUST NOT call ElevenLabs.
- `audio generate "<texto>" --json --execute` MUST generate (and with `--send`
  deliver through the media sender).
- `audio tts "<texto>" --json` without `--execute` MUST exit 3 and MUST NOT
  emit `ravi.tts`; with `--execute` the emit MUST happen.
- Text validation (`Provide text or --text-file.`, unsafe `--text-file` paths)
  MUST fail with exit 1 BEFORE any brake output.
- `audio voices --json --fields a,b` MUST narrow each voice object to the
  requested fields; `audio pending --json --fields a,b` MUST narrow each item.
- `audio blob <id>` MUST keep returning the raw binary Response (allowlisted;
  never migrated to JSON envelopes).
- `bun test src/cli/commands/media-json.test.ts` SHOULD pass after any change
  to the audio contract surface.
