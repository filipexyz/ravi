# Ravi Specs / CHECKS

## Checks

- `ravi specs new specs/test --title "Test Capability" --kind capability --json` creates `SPEC.md` with id `specs/test`.
- `ravi specs get specs --mode rules --json` returns only inherited `SPEC.md` content.
- `ravi specs get specs --mode full --json` returns `SPEC.md`, `WHY.md`, `RUNBOOK.md`, and `CHECKS.md` when present.
- `ravi specs sync --json` rebuilds the index without requiring any hand-authored registry.
- `ravi projects link <project-id> spec specs` validates that the target spec exists before creating the link.
- Invalid ids such as `a/b/c/d` fail with a clear error.
- Kind/depth mismatches fail with a clear error.
- All `ravi specs` commands remain covered by JSON CLI coverage.
- `specs facade plan new ... --json` leaves both `.ravi` and `ravi.db` absent in an empty isolated workspace.
- Facade `new` blocks missing ancestors, invalid id/kind, orphan directories, stale hashes, and supported symbolic-link paths without creating or replacing target files.
- A blocked facade plan becomes stale when its blocker set changes and must be planned again before apply.
- Applying an exact facade `new` plan creates the requested files atomically, verifies their hashes, and returns `noop` on exact replay.
- Adding an unexpected file after apply makes the target divergent, exposes the path in readback, and prevents exact replay.
- Changing a created file causes `verify` to return `divergent`, `recover` to return `manual_review`, and another old-hash apply to fail stale.
- A forced failure before directory promotion leaves no target and no staging directory; competing creators expose one complete quartet only.
- Legacy `new` still populates a pre-created directory without `SPEC.md`, while facade `new` rejects the same orphan target.
- `cwd`, the real specs-root identity, and the real database parent/file identity produce different plan hashes; replacing either object at the same textual path makes the old plan stale.
- Relative database state binds canonically; a symbolic-link component is rejected before database creation.
- Two facade `sync` applications over unchanged Markdown return `applied` then `noop`, and readback reports a matching index.
- Changing Markdown after sync validation does not change the captured snapshot written by that apply.
- A deterministic hook after the final staging identity check swaps the Linux stage; the substituted directory is removed from the public target name by a verified rename rollback, and the pinned original stage is cleaned.
- A deterministic hook immediately before SQLite open swaps the planned database directory or file; Linux requires the newly opened SQLite connection to expose a new process descriptor for the pinned inode before any pragma or SQL executes, while Windows blocks the rename through handle sharing and completes only against the pinned target.
- A forced Linux `openat2`-unavailable result immediately after `mkdirat` leaves no operation-created empty `.ravi` or `.ravi/specs` directory.
- The Windows addon MUST execute through both Bun and Node. Linux-only promotion and `openat2` rollback checks MUST execute in Ubuntu CI before promotion and MUST NOT be reported as locally executed on Windows.
- `readback`, `verify`, and `recover` do not write; recovery returns `replay:false`.
- Published contracts reject cross-operation `new`/`sync` payload combinations.
- `bun test src/specs/service.test.ts src/specs/facade.test.ts src/cli/commands/specs.test.ts` MUST pass.
