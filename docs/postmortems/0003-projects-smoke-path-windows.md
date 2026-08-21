# Postmortem 0003: Projects init smoke used a POSIX-only path

## Status

Resolved locally on 2026-08-21. Promotion remains subject to the normal
Projects review and CI gates.

## Impact

The native `projects init` smoke test failed on Windows even though the CLI
created all four expected links. The test supplied `/tmp/ravi.bot` and required
that exact spelling, while the CLI correctly normalized it to
`C:\tmp\ravi.bot`. The asymmetric nested matcher also hid the path difference
behind an unhelpful array diff.

## Detection

The full Projects matrix passed 52 of 53 tests. Running the same test on the
approved Commands SHA `e91cfec9` reproduced the identical failure, proving it
was not introduced by the read facade.

## Root cause

The fixture treated a POSIX absolute path as portable test data. It asserted a
hard-coded locator rather than deriving the expected canonical path from the
host. The nested `arrayContaining` matcher made diagnosis harder.

## Correction

The smoke now passes the resolved repository root as the worktree resource,
derives its label with `basename`, and asserts each required link explicitly.
The corrected native test passes on Windows and remains valid on POSIX hosts.

## Prevention

- Cross-platform filesystem fixtures must use `resolve`, `tmpdir`, or a real
  repository path.
- Assertions compare canonical host paths, not a path syntax from another OS.
- A baseline reproduction is required before labeling a focused-suite failure
  as a regression.
