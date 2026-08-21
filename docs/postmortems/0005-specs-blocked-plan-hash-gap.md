# Postmortem 0005: blocked specs plan did not bind its blockers

**Date:** 2026-08-21
**Severity:** high
**Status:** corrected locally; final gates pending
**Project:** Ravi

## Summary

Manual pre-package review found that `planHash` bound the workspace, normalized
input, targets, and effects but omitted the current blocker set. A plan refused
for missing ancestors could therefore retain the same hash after another actor
created those ancestors. Applying the old hash would then be accepted without a
fresh planning decision.

## Impact

No commit, package, push, PR, remote call, or VPS deployment contained this
behavior. The issue existed only in the uncommitted domain candidate.

## Root cause

The initial hash was designed around intended effects and exact replay. The
review checked replay stability but did not yet include the opposite transition:
a blocked plan becoming executable because external context changed.

## Resolution

The canonical hash input now includes the structured blocker set. A successful
plan still keeps the same hash after its own exact application, preserving safe
`noop` replay. A formerly blocked plan receives a different current hash when
its blockers change, so the old hash fails with `PLAN_STALE` before mutation.

## Prevention

- Exercise blocked-to-executable transitions in every two-phase facade.
- Bind authorization-relevant observations even when intended effects are
  unchanged.
- Review both replay stability and stale-plan invalidation before packaging.

## Revision note — 2026-08-21 (closure)

The corrected transition passed the native suite and the built CLI process
check. After an ancestor was added, applying the formerly blocked hash exited
with code 1 and `PLAN_STALE`; the target remained absent. Typecheck, build, SDK,
OpenAPI, Swift artifact, quality, formatting, documentation, and package gates
also passed on the corrected tree.
