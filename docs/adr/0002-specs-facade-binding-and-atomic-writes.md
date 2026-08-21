# ADR 0002: Bind specs facade plans and apply file creation atomically

**Date:** 2026-08-21  
**Status:** accepted

## Context

`ravi specs new` created `SPEC.md` and its optional companions one file at a
time. A failure could leave a partial quartet, an orphan target directory could
be overwritten, concurrent creators could collide, and symbolic links could
redirect the write outside the intended tree. `ravi specs sync` also replaced
the SQLite index when its content was already current.

Agents need a safe facade without breaking the established local commands used
by people, documentation, and CI. A facade plan is classified as a read and
therefore cannot persist hidden state.

## Decision

Add `ravi specs facade plan|apply|readback|verify|recover` for the `new` and
`sync` intentions.

- A plan is stateless and does not create directories, files, or database
  state. The caller supplies the same normalized intention and `planHash` to
  later operations.
- The hash binds the canonical working directory, `.ravi/specs` root, Ravi
  database path, normalized input, exact file-content hashes, current safety
  blockers, and, for `sync`, the source index digest. A changed blocker set
  makes the old plan stale. No CLI option accepts an arbitrary filesystem root.
- Facade `new` blocks when required ancestor `SPEC.md` files are absent. The
  legacy `new` command preserves its explicit compatibility behavior and still
  reports missing ancestors after creation.
- Applying an identical facade `new` plan to an exact existing target returns
  `noop`. Legacy `new` continues to fail with `Spec already exists`.
- New files are written into a private sibling staging directory and promoted
  by one directory rename. Existing orphan directories and symbolic links in
  the path are rejected without overwrite.
- Legacy `new` and facade `new` delegate to the same atomic writer. Legacy
  `sync` and facade `sync` delegate to the same compare-before-replace index
  service.
- `readback`, `verify`, and `recover` are read-only. They expose the bound
  targets, ancestor state, expected versus observed file hashes, and SQLite
  index state. Recovery never replays an effect.

## Alternatives considered

- **Persist facade plans in SQLite.** Rejected because it would turn `plan`
  into a hidden write and require lifecycle cleanup for a local reversible
  operation.
- **Accept a caller-provided specs root.** Rejected because it would weaken the
  binding and expand the write boundary beyond the current Ravi workspace.
- **Create missing ancestor specs automatically.** Rejected because titles,
  ownership, and invariants cannot be inferred safely.
- **Write each quartet file directly and remove partial output on failure.**
  Rejected because a crash can occur before cleanup and concurrent writers
  still share the visible target.
- **Make legacy `new` idempotent.** Rejected because existing users rely on a
  collision being visible. Idempotent replay belongs to the facade contract.

## Consequences

- Agents can inspect a concrete effect before applying it and can prove the
  result through an independent read path.
- Local creation no longer exposes a partially written target directory under
  ordinary filesystem rename guarantees.
- A stale or differently bound hash is rejected before mutation.
- The facade call is intentionally more explicit: callers must retain the hash
  and repeat the normalized intention because no plan record is persisted.
- A filesystem that cannot provide ordinary same-parent rename semantics is not
  an approved deployment target for this facade.
