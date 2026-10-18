# Ravi Specs / CHECKS

## Checks

- `ravi specs new specs/test --title "Test Capability" --kind capability --json` creates `SPEC.md` with id `specs/test`.
- `ravi specs get specs --mode rules --json` returns only inherited `SPEC.md` content.
- `ravi specs get specs --mode full --json` returns `SPEC.md`, `WHY.md`, `RUNBOOK.md`, and `CHECKS.md` when present.
- `ravi specs sync --json` rebuilds the index without requiring any hand-authored registry.
- Invalid ids such as `a/b/c/d` fail with a clear error.
- Kind/depth mismatches fail with a clear error.
- All `ravi specs` commands remain covered by JSON CLI coverage.
