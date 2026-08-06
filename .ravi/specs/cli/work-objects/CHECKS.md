# Work Objects agent-first CLI contract / CHECKS

## Checks

- `work-objects action` without `--execute` MUST exit 3, MUST report
  `dryRun: true` with the `{ref, actionId, value?}` plan, and MUST NOT call
  any adapter; with `--execute` the adapter call MUST happen.
- `work-objects action` MUST validate `type`, `id` and `actionId` BEFORE the
  brake — an empty actionId fails with a usage-style error, never exit 3.
- `work-objects resolve|update|action|suggest` on a reference no adapter
  handles MUST exit 1 with the `WORK_OBJECT_NOT_FOUND` envelope and a
  `suggestedAction` pointing to the adapter-backed listing.
- `work-objects update` MUST keep immediate-write behavior (declared
  unbraked): a valid `--values` patch reaches the adapter without `--execute`.
- Adapter results carrying `fieldErrors`/`formError` MUST pass through as
  successful envelopes — the CLI must not convert adapter validation into
  contract errors.
- The daemon NATS path (`ravi.work_objects.action`) MUST remain unaffected by
  the CLI brake.
- An invalid flag on any `work-objects` op SHOULD exit 2 with
  `acceptedFlags`.
- `bun test src/cli/commands/work-objects.test.ts` SHOULD pass after any
  change to the work-objects CLI surface.
