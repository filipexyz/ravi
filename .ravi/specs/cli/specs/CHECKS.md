# Specs agent-first CLI contract / CHECKS

## Checks

- `specs get <unknown-id> --json` MUST exit 1 with the `SPEC_NOT_FOUND`
  envelope and up to three `suggestions` of real spec ids, even though
  `getSpecContext` throws plain errors on unknown ids.
- `specs get <id> --mode <bogus> --json` MUST exit 2 with `USAGE_ERROR` and
  `acceptedValues` of `rules|full|checks|why|runbook`.
- `specs list --kind <bogus> --json` and `specs new <id> --kind <bogus>`
  MUST exit 2 with `USAGE_ERROR` and `acceptedValues` of
  `domain|capability|feature`; `specs new` without `--title` or `--kind` MUST
  exit 2 too.
- `specs list --fields a,b,c --json` MUST return both `items` and `specs`
  containing only the requested fields.
- `specs new` MUST stay unbraked: it creates local files immediately, and an
  existing id MUST keep failing with `Spec already exists` (exit 1) — no
  overwrite path may be added without revisiting this spec.
- `specs sync` MUST stay unbraked and idempotent: no `--execute`, exit 0 on
  success — the CI quality gate (`syncSpecs()` in `src/ci/quality-gate.ts`)
  and the many spec CHECKS embedding `ravi specs sync --json` depend on it.
- The suggestions helper MUST tolerate a missing/unreadable index by
  returning empty suggestions instead of throwing a second error.
- `bun test src/cli/commands/specs.test.ts` SHOULD pass after any change to
  the specs contract surface.
- `specs facade plan` MUST have `effectClass:none` and leave files and SQLite
  unchanged; `facade apply` MUST declare `local-reversible` and require the
  exact copied hash, not `--execute`.
- Invalid facade operation/kind MUST preserve `USAGE_ERROR` through the outer
  catch. Missing ancestors, stale hashes, and conflicts MUST keep their typed
  execution codes.
- A blocked plan hash MUST fail as stale if its blockers change before apply.
- A completed `new` target changed afterward MUST verify as `divergent` and
  recover as `manual_review`; applying the old hash MUST still fail stale.
- An additional target file MUST appear in `unexpectedFiles`, make verification
  divergent, and prevent a `noop` replay.
- A sync source changed after plan validation MUST write the captured approved
  snapshot, never a silent second scan.
- Relative database state MUST bind to one absolute path, and an observed
  symbolic-link component MUST fail with `UNSAFE_DB_PATH` without creating the
  database.
- `facade readback|verify|recover` MUST show target files, ancestors, and index
  state without writes; recovery MUST report `replay:false`.
- Return-schema checks MUST accept real `new` and `sync` payloads and reject
  either payload when only its operation discriminator is swapped.
- The facade commands MUST be present in registry, SDK, OpenAPI, and help
  discovery with declared return schemas.
