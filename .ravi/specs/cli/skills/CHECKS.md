# Skills agent-first CLI contract / CHECKS

## Install confirmation matrix

This matrix is the normative behavior table. Automated coverage is
branch-complete over the real decision predicates (`sourceKind === "git"`,
`overwrite === true`, `execute === true`); representative controls may cover
multiple equivalent rows instead of creating one fixture per cell.

| source | overwrite | `--execute` | expected result |
|---|---:|---:|---|
| catalog | false | absent | resolve, select and install immediately; exit 0 |
| local | false | absent | resolve, select and install immediately; exit 0 |
| Git | false | absent | `WRITE_REQUIRES_EXECUTE`; exit 3; selection deferred |
| catalog | true | absent | safely select, then `WRITE_REQUIRES_EXECUTE`; exit 3; `skillCount` known |
| local | true | absent | safely select, then `WRITE_REQUIRES_EXECUTE`; exit 3; `skillCount` known |
| Git | true | absent | `WRITE_REQUIRES_EXECUTE`; exit 3; selection deferred |
| catalog | false | present | resolve, select and install immediately; exit 0 |
| local | false | present | resolve, select and install immediately; exit 0 |
| Git | false | present | resolve, select and install, or return the post-confirmation domain error |
| catalog | true | present | resolve, select and overwrite, or return the post-confirmation domain error |
| local | true | present | resolve, select and overwrite, or return the post-confirmation domain error |
| Git | true | present | resolve, select and overwrite, or return the post-confirmation domain error |

`--execute` on an additive catalog/local install is accepted but MUST NOT be
required for success or change its semantics.

## Braked plan and zero-effect checks

- An absent-`--execute` Git row MUST report `dryRun: true` and exactly this plan
  shape: `sourceKind`, controlled `sourceLabel`, `selectionDeferred: true`,
  `overwrite` and `codexSync`.
- An absent-`--execute` catalog/local overwrite row MUST report `dryRun: true`
  and exactly this plan shape: `sourceKind`, controlled `sourceLabel`,
  `skillCount`, `overwrite` and `codexSync`.
- `sourceLabel` MUST equal the controlled enum `catalog`, `local` or `git`; it
  MUST NOT be derived from a basename, repository name or subpath.
- Neither plan shape may contain raw source URLs, local paths,
  basenames/subpaths, destination/plugin paths, skill names, skill content,
  frontmatter or arbitrary metadata. Only the catalog/local overwrite shape
  may include the selected count. Git credentials and URL
  path/query/fragment values MUST not be reproduced.
- The unconfirmed Git control MUST establish that the source resolver is not
  entered before exit 3. The catalog/local overwrite controls MUST establish
  that safe selection happens before exit 3 while the installation and Codex
  synchronization stages are not reached.
- Pure argument validation and pure source-kind parsing may run before every
  brake. Side-effect-free catalog/local lookup and selection also run before
  their overwrite brake; Git resolution MUST NOT.

## Branch-complete control set

- Additive non-Git branch: representative catalog and local controls complete
  immediately without requiring `--execute`.
- Unconfirmed Git branch: a representative Git control returns exit 3 with
  deferred selection before the resolver boundary. The `overwrite` boolean is
  still represented in the plan and does not change this branch ordering.
- Unconfirmed non-Git overwrite branch: representative catalog/local controls
  select safely, preserve not-found ordering and stop before installation.
- Confirmed branch: representative Git/overwrite execution controls proceed
  beyond the brake; an additive non-Git call with `--execute` remains
  semantically identical to the immediate branch.

## Resolution and error-order checks

- An unknown additive catalog/local selection MUST return
  `SKILL_NOT_FOUND`, exit 1, before any destination write.
- An unknown Git selection without `--execute` MUST first return exit 3. Only
  the repeated confirmed invocation may resolve the source and return
  `SKILL_NOT_FOUND`, exit 1.
- An unknown catalog/local overwrite selection MUST return `SKILL_NOT_FOUND`,
  exit 1, before the confirmation brake and before any destination write.
- Install error messages, `suggestedAction` and `suggestions` MUST NOT repeat
  the raw source, URL/path, basename/subpath or source content.
- `skills show <unknown-name> --json` MUST exit 1 with `SKILL_NOT_FOUND` and up
  to three suggestions from the visible catalog/installed universe.
- `skills grant <unknown-agent> <skill> --json`, `skills inspect` and the batch
  agent axis MUST exit 1 with `AGENT_NOT_FOUND` and suggestions of real agent
  ids/names.
- Missing required selection (`name` or `--all`) and invalid flags MUST retain
  the global usage contract and exit 2 where classified by the parser.

## Other domain checks

- `skills grant-batch` and `skills revoke-batch` MUST keep the pre-existing
  `--dry-run` flag (exit 0 preview, no write). No `--execute` may be added.
- `skills list --fields a,b,c --json` and `skills who --fields a,b,c --json`
  MUST return items containing only the requested fields.
- Immediate writes (`sync`, `grant`, `revoke`, and additive catalog/local
  install) MUST remain immediate, and the shipped `skill-creator` guidance
  MUST not teach a redundant confirmation call.
- Git and overwrite examples in the shipped skill, reference docs and CLI
  help MUST teach the exit-3 preview and `--execute` confirmation.
- Existing tests in `src/cli/commands/skills.test.ts` MUST NOT be removed; the
  file also backs the `src/router/` coverage gate, so contract tests are
  additive.
- `bun test src/cli/commands/skills.test.ts` SHOULD pass after any change to
  this domain surface.
