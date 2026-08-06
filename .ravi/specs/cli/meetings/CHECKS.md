# Meetings agent-first CLI contract / CHECKS

## Checks

- `meetings profiles show <unknown-id> --json` MUST exit 1 with the
  `MEETING_PROFILE_NOT_FOUND` envelope and suggestions from the local profile
  catalog.
- `meetings join --profile <unknown-id> --json` MUST exit 1 with the same
  envelope BEFORE the provider executable is resolved.
- `meetings join --dry-run --json` MUST return `mode: "dry-run"` with the
  validated args and MUST NOT join a meeting, spawn a worker or create session
  state — this pre-existing flag is the write-brake equivalent and MUST NOT be
  renamed.
- `meetings profiles list --fields a,b --json` MUST narrow `items` and keep
  the `profiles` alias identical to `items`.
- The unbraked ops (`login`, `finalize`, `profiles init`) MUST keep their
  immediate behavior and their declared rationale comments in code.
- A resolve error on a profile that DOES exist in the catalog MUST keep the
  legacy text failure, never the not-found envelope.
- `bun test src/cli/commands/meetings.test.ts` SHOULD pass after any change to
  the meetings contract surface (login spawn test may skip on Windows).
