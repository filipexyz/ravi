# Library skills on the local runtime / CHECKS

- `org/x`, `clinica/x`, `org:x` and `project:clinica:x` parse to the same items; malformed refs and slugs fail with `LIBRARY_REF_INVALID` (exit 2).
- `ravi skills show <bare>` returns the local skill when one exists, even if the Library has the same slug.
- A bare slug with no local match is fetched from `GET /api/cli/library/skills/<slug>?project=`; a ref from `GET /api/cli/library/skills/<scope>/<slug>`.
- With the Console unreachable, `show` of a cached item returns it with `stale: true`, and `search` scores the cached index with `stale: true`.
- Not logged in: `search` returns local results and `library.status: "skipped"` with a `ravi login` hint.
- Inside an agent runtime: `full-access` passes; an agent with a skill configuration and no grant gets `SKILL_NOT_AUTHORIZED`; after `ravi skills grant <agent> org/x` it passes; `use:skill:org:*` passes for org items only.
- A Library grant or capability never authorizes a local skill named like its slug form (`org-x`), and never joins the provider allowlist.
- An item with `externalAllowed: false` is refused with `LIBRARY_SKILL_EXTERNAL_DENIED` (exit 3) in a turn that is not the operator's own, and is left out of `search` there.
- `ravi skills publish <dir> --scope org` without `--execute` exits 3 with the plan and writes nothing; with `--execute` it posts `baseVersion` equal to the current version (0 for a new item).
- `publish` refuses a folder without `SKILL.md`, without a `description`, over the limits, with unsafe paths, or with a reserved slug, before any request.
- Tests: `bun test src/library/ src/cli/commands/skills-library.test.ts`.
