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
  `COMMAND_FAILED` compatibility error, never the not-found envelope.
- `bun test src/cli/commands/meetings.test.ts` SHOULD pass after any change to
  the meetings contract surface (login spawn test may skip on Windows).
- `meetings join --url <meet> --dry-run --json` without `--local` MUST return
  `runtime: "cloud"` with the normalized Console request and MUST NOT need the
  recorder executable or call the Console.
- `meetings join --url <meet> --out <dir>` without `--local` MUST exit 2 with
  `LOCAL_RECORDER_OPTION`; `--live` MUST still run locally.
- `meetings fetch <id>` MUST finalize a `done` meeting once (a second run
  returns `already_finalized` and informs nobody, with or without a join
  artifact; a later `--video` run updates the same artifact), close the join artifact of a
  `failed` meeting, and leave a running one alone. A run that finds the
  recorded artifact with the join still open MUST close it and inform once.
- The inbox runner MUST hand each newly delivered `meetings.recording.*` item to
  `meetings fetch` exactly once, after the item is delivered locally.
- `meetings read <id> --json` on a turn that is not the operator's own MUST
  exit 3 with `MEETING_ACCESS_DENIED` and MUST NOT call the Console; on the
  operator's turn it MUST POST `{meetingId}` (or `{url}` for a link), print the
  payload with `success: true` and `note`, and write nothing to disk.
- `meetings read` MUST map Console `ORG_ACCESS_DENIED` and
  `PROJECT_ACCESS_DENIED` to exit 3, `NOT_FOUND` and `CONFLICT` to exit 1.
- `meetings read` lets the operator read in a group they chose, as `pages read` does; the calendar (`refuseGroup`) refuses that turn (`turn: group`) (`src/meetings/read.test.ts`).
- The calendar's group refusal carries `ownerAsked`, and its next step sends the operator to their private chat with `chatLine`/`chatLinePt`; anyone else gets the "other people" step (`src/meetings/read.test.ts`).
- Over the remote gateway, `MEETING_ACCESS_DENIED` (`meetings read`) and `CALENDAR_ACCESS_DENIED` (`agenda *`) keep the daemon's message, next step, `refusal`, `turn` and chat lines, never "Remote command was blocked by policy." (`src/cli/remote-gateway.test.ts`).
