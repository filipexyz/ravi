# Skills agent-first CLI contract / WHY

`ravi skills` is a governance surface: grants decide which skills an agent can
see, while `install` persists skill code in the operator environment. The
confirmation policy therefore follows the effect of each invocation instead
of treating every install verb as equally risky.

An additive install from the bundled catalog or an explicit local source is a
routine, reversible local write. It executes immediately and returns exit 0;
requiring a second identical call would add friction without a material safety
gain.

Two install shapes do gain material safety from confirmation:

- A Git source may require network access and a temporary clone merely to
  discover or select skills. The exit-3 brake occurs before that resolution,
  and `--execute` authorizes both resolution and installation.
- `--overwrite` may replace an existing installed skill. It is braked for
  catalog, local and Git sources before writing. Catalog/local lookup and
  selection remain before the brake because they are side-effect-free; Git
  selection stays deferred because resolution itself has effects.

The Git plan says `selectionDeferred: true` and includes only source kind, a
controlled `sourceLabel` enum (`catalog`, `local` or `git`), overwrite intent
and Codex-sync intent. A catalog/local overwrite plan replaces
`selectionDeferred` with the selected `skillCount`. Neither shape includes a
raw URL, local or destination path, basename/subpath, skill name or skill
content. Errors and suggestions follow the same rule: they never repeat the
source input. This keeps the contract useful for the decision without
duplicating private material into CLI, tool, gateway or audit history.

Deferred Git selection changes error ordering deliberately: a missing Git
skill cannot be reported before confirmation without first resolving the
source. The first call therefore returns exit 3; the confirmed call may then
return `SKILL_NOT_FOUND`, exit 1. Catalog/local installs, including overwrite,
validate selection before an immediate write or exit-3 brake and return
`SKILL_NOT_FOUND` without changing state.

The rest of the surface stays immediate:

- `sync` only re-materializes skills already present in local plugins and is
  idempotent.
- `grant` and `revoke` are reversible visibility changes; braking them would
  put exit-3 friction inside the curation loop without adding safety.
- `grant-batch` and `revoke-batch` retain their pre-existing `--dry-run`
  preview. Renaming it or adding `--execute` would break callers while adding
  no protection. The documented asymmetry is exit 0 for this preview instead
  of exit 3.

Implementation constraints worth retaining:

- Classification may parse a source string to distinguish catalog, local and
  Git. Git must stop before `withResolvedSkillSource`, discovery and selection.
  Catalog/local overwrite may perform side-effect-free enumeration, discovery
  and selection, but must stop before `installSkills` and Codex sync.
- `selectSkills` throws plain errors rather than returning null. Its mapping
  happens before the brake for catalog/local and only after `--execute` for
  Git.
- `installSkills` derives its destination from `homedir()`, so execute-path
  tests isolate `HOME`/`USERPROFILE` and fail closed before a real write if the
  redirect is not honored.
