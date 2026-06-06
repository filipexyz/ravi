# Ravi App Scaffold / CHECKS

## Checks

- Dry-run check
  - `ravi apps scaffold demo-app --dry-run --json`
  - Must not create files.
  - Must return planned manifest/spec/skill paths.

- Write check
  - `ravi apps scaffold demo-app --json`
  - Must create a valid manifest.
  - Must create spec and skill skeletons by default.

- Validation check
  - `ravi apps check demo-app --json`
  - Must pass immediately after scaffold in a clean repo.

- Safety check
  - Re-running without `--force` must fail when target files exist.
  - Re-running with `--force` may overwrite files and must report overwritten
    actions.

- Skill check
  - Scaffolded manifest must include the generated skill id.
  - Generated skill must teach agents to use `ravi apps show`, `ravi apps
    check`, and declared operations.
