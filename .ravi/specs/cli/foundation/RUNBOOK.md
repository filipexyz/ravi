# Agent-first CLI foundation / RUNBOOK

## Diagnose an incomplete response

1. Re-run the command with `--json` and stdout redirected through a pipe.
2. Confirm that the process exits only after the complete JSON document can be
   parsed.
3. If the payload is incomplete, inspect the common output writer and all
   immediate `process.exit()` paths before changing a domain command.
4. If a process remains alive with no output progress, confirm that the common
   writer reaches its five-second flush bound and that termination runs from the
   guaranteed cleanup path. Never replace the bound with an unbounded poll.

The migrated boundary covers registered one-shot CLI commands. The remaining
direct exits are explicit lifecycle exceptions: daemon log/follow callbacks,
interactive setup/session loops, instance connection listeners, and spawned
service callbacks. They do not establish the output guarantee for structured
one-shot responses and must be migrated and tested in their owning domain PRs.

## Diagnose a generic error

1. Decide whether the failure is expected and safe to disclose.
2. Expected validation failures use a typed public error with a domain code.
3. Caller mistakes use `USAGE_ERROR` and exit code `2`.
4. Unexpected exceptions keep a generic public message; inspect protected logs
   for internal details.

## Diagnose field selection

1. Read `acceptedFields` from the command's usage-error envelope.
2. Retry with only declared public fields.
3. If unknown fields succeed on an empty result set, validation is occurring too
   late and the foundation contract has regressed.

## Diagnose a confirmation mismatch

1. Inspect the exported effect, risk, and confirmation metadata.
2. Run the command without confirmation against an isolated native test state.
3. Verify that no database write, event, provider call, child process, or remote
   request occurred.
4. Treat a metadata-only pass as a failed safety check.

## Diagnose catalog drift

1. Compare `ravi tools ... --json` with the host runtime dynamic-tool catalog.
2. Confirm both surfaces carry operation kind, effect class, risk,
   confirmation requirement, and classification source.
3. Treat `unclassified` as an unresolved migration state, never as permission
   to execute without the command's existing authorization and brake.
