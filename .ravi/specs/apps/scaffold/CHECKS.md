# Ravi App Scaffold / CHECKS

## Checks

- Dry-run check
  - `ravi apps scaffold demo-app --dry-run --json`
  - Must not create files.
  - Must return planned CLI/manifest/spec/skill paths.

- Write check
  - `ravi apps scaffold demo-app --json`
  - Must create a valid manifest.
  - Must create a runnable `src/apps/demo-app/cli.ts` by default.
  - Must create spec and skill skeletons by default.

- Validation check
  - `ravi apps check demo-app --json`
  - Must pass immediately after scaffold in a clean repo.
  - Manifest must declare a real/draft CLI command, not `ravi demo-app`.
  - Default manifest command must be `bun cli.ts`.
  - Manifest must declare `context.allow: []` by default.
  - Manifest must omit executable health unless a supplied CLI contract
    declares a safe implementation health command.

- Safety check
  - Re-running without `--force` must fail when target files exist.
  - Re-running with `--force` may overwrite scaffold-owned contracts and must
    report overwritten actions.
  - An existing generated `cli.ts` must be preserved and reported as
    `preserved`, because it is implementation-owned after the first scaffold.

- Skill check
  - Scaffolded manifest must include the generated skill id.
  - Generated skill must teach agents to use `ravi apps show`, `ravi apps
    check`, and declared operations.

- Executor check
  - Generated domain operations must use `cli`.
  - `ravi demo-app list --json` must execute the generated CLI through the
    generic App Router.
  - Generated discovery/help/check placeholders may use allowlisted `builtin`.
  - Scaffold must not generate SDK, tool, or stream operation executors.
