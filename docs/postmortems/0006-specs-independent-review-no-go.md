# Postmortem 0006: independent specs review rejected the first commit

**Date:** 2026-08-21

**Severity:** high

**Status:** open; correction in progress

**Project:** Ravi

## Summary

Independent review rejected commit
`fc0e273f89bae486a2e089524c9ea85e8251caab` before push or PR. The review
found that facade sync could validate one Markdown snapshot and write a later
snapshot, while new readback could turn ordinary post-apply divergence into
`PLAN_STALE` instead of returning `divergent` and `manual_review`.

The reviewed package with SHA-256
`80C2ED8F658DFE26397C15C9FCEA0F92BA25B8989EE3E274A7A770CB012E5D9B` is
rejected for promotion.

## Additional findings

- The SQLite binding used the raw database path and did not reject observed
  symbolic-link components.
- Legacy `new` no longer accepted a pre-created target directory without
  `SPEC.md`, unlike the base behavior.
- Public plan schemas used independent unions and therefore admitted impossible
  new/sync field combinations.
- Native tests omitted source change during sync, post-apply divergence, write
  failure, competing creators, unsafe database bindings, and direct invalid
  facade ids.

## Root cause

The first implementation recomputed a complete current plan for every phase.
That was sufficient for exact replay but conflated immutable intended effects
with mutable observations. Sync also called the legacy service after plan
validation, causing a second source scan instead of applying the captured
snapshot.

## Impact

No push, domain PR, merge, remote call, or VPS deployment occurred. The defect
was limited to a local commit and an external local package.

## Required resolution

- Apply sync from the exact snapshot used to validate the hash.
- Let observation phases validate the original executable plan identity while
  still reporting current divergence.
- Canonicalize and revalidate the SQLite path, rejecting observed links.
- Restore or explicitly migrate the legacy orphan-directory behavior.
- Generate discriminated public contracts and add the missing native tests.
- Produce a new commit, package, complete gate run, and independent review.

## Revision note: 2026-08-21, corrective implementation

The replacement implementation now applies sync from the exact captured
Markdown snapshot and keeps strict stale-plan validation for mutation. New
readback, verification, and recovery recognize the identity of the originally
executable plan, so a later target edit is classified as `divergent` and
`manual_review` while another apply remains stale.

The database target is bound as an absolute path, revalidated before writes,
and rejected when an existing path component is symbolic. Legacy `new` again
populates a pre-created directory without `SPEC.md`; facade `new` continues to
reject that orphan target. Public schemas are now discriminated by operation.

Native tests cover post-apply edits, sync source changes after validation,
interrupted promotion, competing creators, relative and symbolic database
bindings, direct invalid ids, legacy compatibility, and cross-operation return
payload rejection. At this checkpoint, 21 service/facade tests passed with 79
assertions, 12 CLI specs tests passed with 65 assertions, typecheck passed, and
Biome passed on the changed source. Generated artifacts, the complete gate run,
a replacement package, and a fresh independent review are still pending, so
the candidate remains NO-GO for push or PR.

## Revision note: 2026-08-21, SDK schema-quality recapture

The first generated-contract run after the corrective implementation produced
current OpenAPI and Swift artifacts, but `test:sdk` rejected all five facade
returns as newly weak. Runtime schemas and generated TypeScript unions were
correlated correctly; the quality analyzer classified Zod tuples as arrays
without recognized item schemas.

No exception or baseline entry was added. The corrective path replaces the
empty and single-item tuples with typed arrays constrained to maximum length
zero or exact length one. All generated artifacts and SDK gates must be
repeated after that change. The candidate remains NO-GO.

## Revision note: 2026-08-21, discarded local quality-gate capture

The first local quality-gate command after regeneration passed an incorrectly
nested PowerShell collection. The runner received `System.Object[]` plus the
untracked postmortem instead of the real changed paths, skipped both gates, and
printed a false `PASSED` result.

That output is discarded and is not product evidence. The command must be
repeated with each Git result emitted as a flat list, including untracked files,
before the gate can contribute to a GO decision.

## Revision note: 2026-08-21, incomplete Windows full-suite run

The local `bun run test` entered the unchanged channels suite first. One Slack
test expected a mixed-separator path ending in `/attachments/`, while Windows
correctly emitted `\\attachments\\`; no Slack source or test is changed by this
candidate. After reporting that failure, the channels process remained
CPU-active without completing for several minutes and was interrupted. The run
is incomplete and cannot count as a full-suite pass.

The separate Swift package test could not start because `swift` is not installed
on this Windows host. That is recorded as locally unavailable, not as a pass or
a product failure. The Slack case must be recaptured in isolation, and the
remaining native groups must be run separately. Linux CI on the exact candidate
SHA remains mandatory.

## Revision note: 2026-08-21, Windows recapture boundaries

The Slack failure was reproduced in isolation. Its expectation combines the
Windows temporary root with a POSIX `/attachments/` suffix, while the runtime
returns native Windows separators. The candidate changes neither the Slack
source nor that test relative to `origin/dev`.

The remaining native groups were recaptured separately. The core group reported
585 passes, 8 failures, and 1 error; the tasks/projects group reported 247
passes, 5 skips, and 16 failures. The failures were outside the specs diff and
were dominated by unchanged five-second adapter timeouts, Windows path/profile
assumptions, and the existing project smoke matcher. The `test:cli-commands`
package wrapper also uses a POSIX `for` loop that PowerShell cannot execute; its
changed specs test was therefore run directly and passed. None of these partial
runs is represented as a complete-suite pass.

The repository-wide Biome invocation likewise exposed inherited CRLF formatting
diagnostics across unrelated source files. Biome passes on all eight source
files changed by the specs candidate. The generated checks and Linux CI on the
exact commit remain the cross-platform authorities.

## Revision note: 2026-08-21, unexpected-file divergence and gate recapture

A final coordinator review found that exact replay compared the four expected
files but did not reject additional files in the target directory. Such a
target could be reported as a safe `noop`. Exact matching, readback, verification,
recovery, blockers, public schemas, documentation, and native tests now include
unexpected files. An extra file produces a conflict for a fresh plan and
`divergent`/`manual_review` for the original plan; another apply remains stale.

The first focused rerun after this correction exposed a no-op test injection:
the generated YAML title is quoted, but the test attempted to replace an
unquoted title. The test now asserts that its injected mutation happened before
checking snapshot isolation. The rerun passed 34 tests with 151 assertions.

After regenerating every public artifact, the SDK suite passed 75 tests with 297
assertions and `sdk:check`; both OpenAPI snapshots and the generated Swift SDK
were current. Typecheck, the full build, focused Biome, the clean quality gate
over 70 tracked paths with 274 specs indexed, and Markdown lint over 9 applicable
documents also passed. The unavailable local Swift package test, exact package,
fresh independent review, and Linux CI are still pending. The candidate remains
NO-GO for push or PR at this checkpoint.
