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
