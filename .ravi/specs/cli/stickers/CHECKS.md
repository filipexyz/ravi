# Stickers agent-first CLI contract / CHECKS

## Checks

- `stickers send <id> --json` without `--execute` MUST exit 3 with
  `dryRun: true` and the sticker/target `plan`, and MUST NOT emit
  `ravi.stickers.send`. The plan MUST contain label/chat/thread presence, not
  their values.
- `stickers send <id> --json --execute` MUST emit the send event once.
- `stickers send <unknown-id> --json` MUST exit 1 with the `STICKER_NOT_FOUND`
  envelope and up to three `suggestions` from the local catalog.
- Channel-capability rejection (e.g. Matrix) MUST happen BEFORE the brake, with
  no plan shown and nothing emitted.
- `stickers remove <id> --json` without `--execute` MUST exit 3 and the sticker
  MUST still exist; its plan MUST use label presence and media kind/name rather
  than label/media path. With `--execute` it MUST be removed.
- `stickers remove <unknown-id> --json` and `stickers show <unknown-id> --json`
  MUST exit 1 with `STICKER_NOT_FOUND`.
- `stickers add` MUST keep immediate (unbraked) execution as declared.
- `stickers list --json --fields a,b` MUST narrow both `items` and `stickers`
  to the requested fields.
- The sessions builder MUST render `ravi stickers send <sticker-id> --execute`
  and the live prompt section MUST teach the flag.
- `bun test src/cli/commands/stickers.test.ts` SHOULD pass after any change to
  the stickers contract surface.
