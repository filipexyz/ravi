# Runtime presets agent-first CLI contract / CHECKS

## Checks

- `runtime presets show <unknown-id> --json` MUST exit 1 with the
  `PRESET_NOT_FOUND` envelope and up to three `suggestions` built from real
  preset ids.
- `runtime presets delete <unknown-id> --json` (and `set`, `impact`,
  `enable`, `disable` on unknown ids) MUST exit 1 with `PRESET_NOT_FOUND`
  even though the store raises `RuntimeModelPresetError` for that case.
- The pre-existing `--dry-run` flag on `set`, `enable`, `disable` and
  `delete` MUST keep its name and semantics: exit 0, `dryRun: true` in the
  payload, nothing persisted, no version bump — it MUST NOT be renamed to
  `--execute`.
- A `delete --dry-run` call MUST leave the preset listable afterwards.
- The store reference guard MUST keep blocking `disable`/`delete` of a preset
  that agents still reference, with the `Next:` hint pointing at `impact`.
- `runtime presets list --fields a,b,c --json` MUST return preset items
  containing only the requested fields.
- Error envelopes in this domain MUST carry only preset ids in suggestions;
  free-text fields such as descriptions MUST NOT leak into the envelope.
- The test suite `bun test src/cli/commands/runtime-presets.test.ts` SHOULD
  pass after any change to this contract surface.
