# YouTube agent-first CLI contract / CHECKS

## Checks

- `yt video <unknown-id> --json` MUST exit 1 with the `VIDEO_NOT_FOUND`
  envelope and a `suggestedAction` pointing at `yt videos`/`yt search` (no
  fabricated suggestions — there is no cheap local video source).
- Each of the seven braked mutations (`reply`, `video-update`, `video-delete`,
  `playlist-create`, `playlist-delete`, `playlist-add`, `playlist-remove`)
  without `--execute` MUST exit 3, MUST report `dryRun: true` with the `plan`,
  and MUST NOT invoke the provider client.
- The same braked ops with `--execute` MUST perform the provider call.
- The `--execute` flag MUST be the last declared option (by decorator index)
  of every braked mutation.
- `yt videos --fields a,b,c --json` MUST return video items containing only
  the requested fields; the same holds for the other listings that declare
  `--fields`.
- A `ContractError` thrown inside the `yt` execute wrapper MUST be rethrown
  unchanged, never converted into the legacy provider-error text.
- `bun test src/cli/commands/youtube.test.ts` SHOULD pass after any change to
  the yt contract surface.
