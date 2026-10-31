---
id: quality/production-boundary
title: "Development and Production Boundary"
kind: capability
domain: quality
capability: production-boundary
status: active
normative: true
applies_to:
  - src/db/production-boundary.ts
  - src/router/router-db.ts
  - src/test/ravi-state.ts
  - scripts/publish-branch.ts
  - .github/workflows/ci.yml
---

# Development and Production Boundary

## Invariants

- A writable SQLite connection MUST check its target before opening the file or running schema initialization. A command called `get` or `list` is not proof of read-only behavior: lazy initialization also migrates.
- All writable Ravi state constructors MUST use `openStateDatabase`. Stores that create directories, move legacy files, or cache handles MUST check the target before those operations and before cached reuse.
- The default production state root (`~/.ravi`) MUST be protected, including symlink aliases and descendants. `RAVI_PRODUCTION_STATE_DIR` MAY protect an additional root and MUST NOT unprotect the default.
- A protected writable connection MUST fail closed with `PRODUCTION_DATABASE_REFUSED` unless the process explicitly confirms the exact absolute root through `RAVI_CONFIRM_PRODUCTION_STATE_DIR`. This confirmation authorizes schema initialization, including destructive migrations; it is not merely consent to read.
- Test processes MUST NOT accept production confirmation. Setting `RAVI_STATE_DIR` to production does not count as confirmation. Hardlinked database files MUST be refused because WAL identity is path-based.
- Development and CI MUST use explicit isolated `RAVI_STATE_DIR` values. Removing that variable MUST cause refusal, never fallback writes to production. Test fixture cleanup MUST restore the previous value, including absence.
- Readonly connections with `create: false` or equivalent MAY inspect a database without schema initialization. They MUST NOT call a migrating initializer.
- Legacy automatic movement of `~/ravi/ravi.db` MUST NOT happen from an unconfirmed process. No test may use that location as a scratch fixture.
- This guard is an accident boundary, not an OS security sandbox. Code with filesystem access can still deliberately bypass library APIs. Review MUST reject new unguarded writable SQLite constructors.

## Publication on a production host

- A production host MUST NOT run full builds, dependency installation in new worktrees, or the complete suite as a prerequisite to publishing a work branch.
- `scripts/publish-branch.ts` is the sanctioned Git Data API path. It MUST preview by default, require a clean committed tree, run focused file tests and the spec/coverage gate in isolated state, and require `--execute` before remote writes.
- Publication MUST preserve the checked HEAD tree exactly (including deletes, executable bits, symlinks and binary blobs) and verify blob/tree hashes before creating a ref.
- The tool MUST create only new work branches, MUST NOT update existing refs, and MUST NOT target `dev`, `main`, release branches or tags. Ref creation races MUST fail.
- A PR against `dev` MUST run the existing complete CI build, typecheck, lint and suite. Publication success is not validation success; merge requires green CI and the operator's merge instruction.
- Hooks MUST NOT be disabled or reconfigured to make publication possible, including per-command `git -c core.hooksPath=/dev/null push`; unchanged persistent config does not make that compliant. Ordinary `git push` retains the full hook on development machines; production hosts use the documented publication tool.

## Failure patterns

Absence of a development/production boundary turns convenience into state corruption: a lazy default plus test cleanup can apply unreleased migrations to the live database. A wrapper's initial environment is not an invariant.

A hook that cannot be fulfilled on its host generates cultural bypass: agents invent exceptional transports or disable checks. Provide a supported light publication path with explicit remote CI responsibility instead.
