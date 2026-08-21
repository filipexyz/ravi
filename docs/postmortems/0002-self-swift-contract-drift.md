# Postmortem 0002: self handoff left Swift contracts stale

**Date:** 2026-08-21

**Severity:** medium

**Status:** open; correction in progress

**Project:** Ravi

## Summary

The coordinator's final generated-contract check found five Swift SDK artifacts
that differed from the live registry after the `self` return schemas changed.
Both OpenAPI snapshots were current. No commit, package, push, PR, merge, or VPS
operation had occurred for this domain.

## Root cause

The local handoff regenerated TypeScript and OpenAPI outputs but did not prove
the Swift surface against the final registry. The change removes all eight
`self` commands from the weak-schema baseline, so every generated language must
be refreshed independently.

## Impact

The uncommitted worktree was not promotable. A package built in this state could
have exposed stale Swift schemas even though runtime and TypeScript contracts
were current.

## Required resolution

- Regenerate the Swift SDK with the repository CLI.
- Repeat Swift drift, SDK, OpenAPI, typecheck, build, focused source, docs, and
  quality gates.
- Produce an exact commit and installed package, then require a fresh
  independent review and Linux CI before push or PR.

## Parallel-run note

The same recapture ran SDK and quality tests concurrently. One SDK hook and two
quality hooks exceeded their unchanged five-second limit. Those results are
discarded and must be repeated in isolation; they are not treated as either
product failures or passes.

## Revision note: 2026-08-21, generated surfaces recaptured

The official Swift generator refreshed all five files and its deterministic
check passed. The isolated SDK rerun passed 75 tests with 297 assertions and
`sdk:check`; the isolated quality suite passed 41 tests with 92 assertions.
Both OpenAPI snapshots remained current.

The final self/runtime slice passed 24 tests with 101 assertions. Typecheck,
full build, focused Biome over 11 sources, Markdown lint over 14 documents,
`git diff --check`, and the quality runner over 65 accumulated paths passed.
The runner indexed 274 specs and approved `cli/live-operational-help`,
`cli/self`, `self`, and the foundation spec. Real root/self help exited zero,
reported unavailable capabilities honestly without context, labeled context
source, and exposed the read-only environment contract.

The Swift drift and duplicate spec-title/line-ending corrections are closed
locally. Exact commit, installed package, independent review, and Linux CI are
still mandatory before push or PR; merge and VPS remain out of scope.

## Revision note: 2026-08-21, independent audit returned NO-GO

The independent read-only audit of commit
`2bf5288b0dd0706a0fab303ed33239a055f4a264` superseded the previous local
recapture. Although the focused native gates were green, inspection and real
process probes found release-blocking gaps in the side-effect boundary and in
the generated contract.

The `self` bootstrap could still touch a registered context before the command
handler ran. Its SQLite reads used the normal writable initializer, which may
create the state directory, migrate data, enable WAL, and update schema. The
CLI, tool adapter, and gateway also emitted NATS audit events for these
read-only orientation calls. In addition, Swift retained weak nested JSON
types, projected context accepted an empty object, recursive redaction did not
cover authorization, cookies, headers, or sensitive values, and root help
could print live `RAVI_*` values.

The candidate is therefore **NO-GO** for push or PR. The corrective round must
use no-touch/read-only bootstrap resolution, an SQLite snapshot opened with
`readonly: true` and `create: false`, `audit: none` across every SELF surface,
concrete generated contracts, non-empty projected context, recursive
redaction, and value-free root help. Native process, SQLite, NATS, redaction,
schema, and help tests plus complete regeneration and gates are required before
a new commit can be considered. Linux CI has not run and is not represented as
passing.

## Revision note: 2026-08-21, generator ownership moved to commands

The `commands` domain is now the exclusive owner of the TypeScript, OpenAPI,
and Swift generator correction. This SELF round selectively removed every
uncommitted change it had made under `src/sdk/client-codegen`,
`src/sdk/swift-codegen`, and the generic OpenAPI emitter test. Those source and
test files have no remaining worktree or staged diff.

The constrained SELF slice passed 122 native tests with 476 assertions,
covering a real process, read-only SQLite snapshot, bootstrap/context behavior,
and CLI/tool/gateway audit suppression. Typecheck, focused Biome, Markdown
lint, and `git diff --check` also passed.

Generated SDK and OpenAPI files currently present are temporary and are not a
valid drift result after the generator changes were removed. The candidate
remains **NO-GO** and must not be committed until it is rebased onto the
`commands` correction, regenerated with the official generators, and the
contract gates are repeated. No push, PR, VPS operation, or Linux CI run took
place.

## Revision note: 2026-08-21, commands integration gates corrected

The approved commit `e91cfec9c85c84f4051910996e26634ad64459eb` was
integrated while preserving the SELF implementation. It is the tip of a
six-commit sequence, so its final delta changed `router-db.ts` while the
matching approved test remained in an ancestor. The first quality runner
correctly rejected that incomplete changed-file slice. Restoring the exact
`src/router/router.test.ts` from the approved commit tree produced 12 passing
tests with 60 assertions; the runner then passed over all 56 accumulated
paths.

An initial attempt to execute all 122 SELF tests in one Bun process was also
discarded: context-registry and dispatcher tests share global state and
interfered with one another. The required files passed in isolated native
processes as 67 tests/246 assertions, 14/61, and 41/169, preserving the exact
122-test/476-assertion proof.

Official TypeScript, OpenAPI, and Swift regeneration and deterministic drift
checks passed. Typecheck, build, focused Biome, native quality gates, and the
domain checks passed. The broad `test:agent-contract` chain still has the same
two Windows artifact-store failures reproduced at foundation `560517a4`: a
blob expectation and symlink creation denied with `EPERM`. These remain a
known base limitation rather than a SELF regression. No version change,
package, push, PR, merge, VPS operation, or Linux CI run occurred.

## Revision note: 2026-08-21, rejected integration claim corrected

The previous statement that the rejected candidate
`0ea16d276b8323f411f8451dd9feb50c88390dc5` fully integrated the approved
COMMANDS tree was false. `e91cfec9c85c84f4051910996e26634ad64459eb`
was not an ancestor of that SHA: the line contained only a partial replay of
the final COMMANDS commit, not the approved six-commit sequence from the
foundation. Historical text remains intact. The rejected candidate remains
**NO-GO** and is preserved at `backup/self-rejected-0ea16d27`.

The corrective branch was rebuilt directly on `e91cfec9`, making the approved
COMMANDS tree a real ancestor before the SELF commits. SELF tools now resolve
the supplied context key again from the trusted registry through a read-only,
no-touch path. They reject fabricated, missing, expired, revoked, or materially
changed contexts with typed failures. Agent, session, binding, conversation,
route, and runtime authority must agree conjunctively before data is exposed;
a cross-agent session fails without disclosing the foreign working directory
or agent data. Native local-tool and gateway tests cover these refusals.

The focused SELF, COMMANDS, registry, tools, gateway, router, quality, SDK,
typecheck, build, generation, and TypeScript/OpenAPI/Swift drift gates passed.
The required COMMANDS process test passed 11/11 with 57 assertions. A first
isolated context-registry run hit a cold-start timeout and was discarded; its
clean rerun passed 14/14. One reapplied dispatcher test omitted the now-required
`name` fixture, correctly received HTTP 400, and passed 42/42 after the fixture
was corrected. Generator runs logged unavailable local NATS at
`127.0.0.1:4222` but completed successfully and deterministically.

The broad `test:agent-contract` chain is not called green on Windows. It ended
with 13/15 artifact-store tests. A direct comparison at the exact approved
COMMANDS worktree reproduced the same two failures: a POSIX-separator blob-path
expectation and symlink creation denied with `EPERM`. They are therefore not a
SELF regression. No version change, package, push, PR, merge, VPS operation, or
Linux CI run occurred; real Swift compilation remains outside this local
evidence.
