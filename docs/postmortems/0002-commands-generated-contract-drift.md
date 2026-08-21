# Postmortem 0002: commands handoff left generated contracts stale

**Date:** 2026-08-21

**Severity:** medium

**Status:** open; replacement candidate in validation

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

## Revision note: 2026-08-21, replacement implementation

The replacement removes non-enumerable projection fields and publishes a
strict non-empty subset schema for the 13 documented command fields. Native
tests validate the return only after JSON round-trip and reject arbitrary
projected keys. The shared gateway fixture was migrated to the same honest
projection contract.

Agent lookup now uses a dedicated read-only SQLite snapshot that bypasses the
normal config store, schema initialization, migrations, and writable database
singleton. COMMANDS declares `audit: none`; CLI, exported-tool, and gateway
paths skip audit transport for both allowed and denied calls. The process test
no longer sets the suppression environment variable and compares command
sources, every SQLite table, and every runtime state file before and after each
operation.

Focused unit, process, gateway, typecheck, and formatting captures are green at
this checkpoint. Generated TypeScript, OpenAPI, and Swift artifacts, full
build, quality gates, exact commit/package, fresh independent review, and Linux
CI must still be repeated. No push, PR, merge, remote call, or VPS action has
occurred.

## Revision note: 2026-08-21, replacement gate recapture

Generated TypeScript, both OpenAPI snapshots, and Swift artifacts were rebuilt
and passed their deterministic checks. The SDK suite passed 75 tests with 297
assertions, the build and typecheck passed, and focused formatting and Markdown
lint were clean. The installed-process slice passed nine tests with 51
assertions while comparing all SQLite tables and state files without audit
suppression.

One parallel gateway run exceeded two inherited five-second timeouts while the
process suite was consuming the same host. That capture was discarded; the
isolated rerun passed all 41 tests with 171 assertions. The first quality-gate
run correctly rejected the new router read path because its approved focused
test was absent from the diff. Two native router cases were added: one proves a
missing database is not created, and one proves an existing agent snapshot
does not alter any state file. The router file then passed 12 tests with 60
assertions, and the repeated quality runner passed over 35 accumulated paths
with 274 specs indexed.

A final adversarial review narrowed `audit: none` itself. Shared policy now
throws unless the command is a low-risk read with resolved effect class
`none`; CLI, tool export, and gateway use the same resolver. The focused
foundation test proves mutations and medium-risk reads cannot opt out. Exact
commit, package, independent review, and Linux CI remain mandatory, so the
replacement is still NO-GO for push or PR at this checkpoint.

## Revision note: 2026-08-21, replacement package capture

Commit `e78e106c5b63df66d16ecccec2f70e29ccfdc844` produced an eight-file
package of 4,945,479 bytes with SHA-256
`C763E1991CDED3A0E2BD50A237FE2F0C6D8BEEB3C018A5239AC140BBB7D42845`.
An empty Bun project installed 367 packages from that archive. Bun reported two
dependency postinstall scripts as blocked by its default trust policy; the Ravi
package still installed with its binary and bundle intact.

The installed bundle, executed directly on Windows, passed bare help, compact
list, show, validate, and rendered run preview. It also returned exit 1 with
`COMMAND_NOT_FOUND` and exit 2 with `USAGE_ERROR` for invalid fields. All seven
processes had empty stderr, the isolated runtime state remained empty, and the
command fixture hash was unchanged.

This note changes the candidate commit, so that first archive is retained as
diagnostic evidence only. The final archive must be rebuilt after the
documentation commit, rehashed, reinstalled, and independently reviewed before
push or PR. Linux CI remains mandatory after an authorized push.
