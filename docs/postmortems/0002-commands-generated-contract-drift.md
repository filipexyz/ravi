# Postmortem 0002: commands handoff left generated contracts stale

**Date:** 2026-08-21

**Severity:** medium

**Status:** corrected locally; gate rerun pending

**Project:** Ravi

## Summary

The implementation handoff reported OpenAPI and Swift artifacts as current,
but the coordinator's official checks found drift in both OpenAPI snapshots and
five Swift files. No commit, package, push, PR, or deployment had occurred.

## Expected behavior

Every CLI contract change must leave TypeScript, OpenAPI, and Swift artifacts
equal to the live registry before a domain can be marked ready.

## Actual behavior

TypeScript SDK generation and `sdk:check` were current. Both OpenAPI checks
failed with `OPENAPI_DRIFT`, and `sdk swift check` reported five divergent
artifacts.

## Root cause

The handoff treated successful TypeScript code generation as evidence for all
generated surfaces. The OpenAPI and Swift checks were not independently
reproduced against the final worktree state before reporting readiness.

## Resolution

The two OpenAPI snapshots and all Swift generated files were regenerated with
the repository's official CLI. Their checks, the SDK suite, and downstream
gates must pass again before the candidate can be committed.

## Prevention

- Record each generated-surface command and exit code separately.
- Do not infer OpenAPI or Swift status from TypeScript SDK status.
- The coordinator must reproduce every claimed gate before accepting a handoff.

## Revision note: 2026-08-21, generated surfaces recaptured

The coordinator regenerated both OpenAPI snapshots and every affected Swift
artifact with the repository CLI. The two OpenAPI checks and the deterministic
Swift check then passed independently. The complete SDK suite passed 75 tests
with 297 assertions and was followed by a green `sdk:check`.

The changed commands slice was repeated after regeneration and passed 40 tests
with 150 assertions, including nine installed-process-style CLI cases. The
typecheck, full build, focused Biome, Markdown lint over nine applicable
documents, and the diff-based quality gate over 23 paths with 274 specs indexed
also passed.

This closes the local generated-drift correction only. An exact commit, package,
fresh independent review, and Linux CI are still mandatory before push or PR;
merge and VPS remain outside this checkpoint.

## Revision note: 2026-08-21, line-ending recapture

A later focused Biome run found Windows line endings in the shared operational
return-schema file after generation. The official formatter normalized that
single file; no schema semantics changed. Focused Biome and the 40-test commands
slice were repeated, with all 150 assertions passing. Evidence recorded before
this normalization is not used as the final style/test capture.

## Revision note: 2026-08-21, final coordinator recapture

The final commands slice passed 40 tests with 150 assertions and typecheck. The
complete SDK suite first ran under parallel load and two unchanged five-second
hooks timed out; that output was discarded. Its isolated recapture passed all
75 tests with 297 assertions and `sdk:check`.

Both OpenAPI checks, the deterministic Swift check, full build, focused Biome
over six command/framework source files, Markdown lint over 11 locally changed
documents, `git diff --check`, 40 native quality-gate tests, and the quality
runner over 56 accumulated foundation-plus-domain paths passed. The runner
indexed 274 specs and approved `cli/commands`, `cli/foundation`, and `commands`.
The generated-drift correction is locally closed. Exact commit, package,
independent review, and Linux CI remain mandatory; push, PR, merge, and VPS have
not occurred.

## Revision note: 2026-08-21, independent package review NO-GO

Independent review rejected commit
`d648b40691300af98818331313a7445b93ab1e90` and its 4,944,320-byte package
with SHA-256
`206A02D753F590AEF798A74DA80C93D93A0963EF0F0ED721A1E9B253A4C2F4AB`.
Neither candidate was pushed or opened as a PR. The historical status in this
document's header describes the earlier generated-drift incident; it does not
override this later NO-GO.

The review found that `--fields` serialized partial records while the Returns,
TypeScript, OpenAPI, and Swift schemas still required complete command records.
Non-enumerable properties let validation pass before serialization but vanished
from actual JSON, so the published contract rejected its own compact output.

The review also disproved the strict read-only claim. Resolving the active agent
through the normal config store opened writable SQLite, initialized schema/WAL,
and changed `ravi.db-wal` and `ravi.db-shm`. The normal registry path also tried
to publish audit events to NATS. The process test hid that transport with
`RAVI_SUPPRESS_AUDIT_EVENTS` and compared only selected tables and command-file
hashes, so it could not detect the state-file changes.

A replacement candidate must publish an honest projected-record schema after
JSON round-trip, remove the non-enumerable-field workaround, resolve command
configuration through a genuinely read-only path, suppress domain audit effects
by declared policy rather than test environment, compare all relevant SQLite
tables and state files, add focused group-help tests, and repeat every generated
artifact and package review. This candidate remains permanently NO-GO.
