# Skills agent-first CLI contract / CHECKS

## Checks

- `skills show <unknown-name> --json` MUST exit 1 with the `SKILL_NOT_FOUND`
  envelope and up to three `suggestions` drawn from the universe searched
  (catalog, installed, or the `--source` being inspected).
- `skills grant <unknown-agent> <skill> --json` MUST exit 1 with
  `AGENT_NOT_FOUND` and suggestions of real agent ids/names; the same applies
  to `skills inspect` and the `--agent` axis of the batch ops.
- `skills install` without `--execute` MUST exit 3, MUST report `dryRun: true`
  with exactly `sourceKind`, path-basename-only `sourceLabel`, `skillCount`,
  `overwrite` and `codexSync`. Raw source/destination paths, plugin bucket
  paths, skill names and skill content MUST be absent, and the command MUST
  NOT write anything to the plugin bucket.
- `skills install <unknown-name>` MUST exit 1 with `SKILL_NOT_FOUND` even
  without `--execute` — validation fires before the brake, never exit 3.
- `skills install <name> --execute` MUST perform the real install and sync
  Codex skills unless `--skip-codex-sync` is passed.
- `skills grant-batch` and `skills revoke-batch` MUST keep the pre-existing
  `--dry-run` flag (exit 0 preview, no write) as the brake equivalent; the
  flag MUST NOT be renamed and no `--execute` may be added to them.
- `skills list --fields a,b,c --json` and `skills who --fields a,b,c --json`
  MUST return items containing only the requested fields.
- Unbraked writes (`sync`, `grant`, `revoke`) MUST keep immediate-write
  behavior and the shipped `skill-creator` skill MUST list them as unbraked.
- The existing tests of `skills.test.ts` MUST NOT be removed — the file backs
  the `src/router/` coverage gate; contract tests are additive.
- `bun test src/cli/commands/skills.test.ts` SHOULD pass after any change to
  the skills contract surface.
