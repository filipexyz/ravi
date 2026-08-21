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
- `cwd`, specs root, and database changes produce different plan hashes.
- Relative database state binds canonically; a symbolic-link component is rejected before database creation.
- Two facade `sync` applications over unchanged Markdown return `applied` then `noop`, and readback reports a matching index.
- Changing Markdown after sync validation does not change the captured snapshot written by that apply.
- `readback`, `verify`, and `recover` do not write; recovery returns `replay:false`.
- Published contracts reject cross-operation `new`/`sync` payload combinations.
- `bun test src/specs/service.test.ts src/specs/facade.test.ts src/cli/commands/specs.test.ts` MUST pass.
