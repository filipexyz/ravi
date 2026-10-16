# Themes agent-first CLI contract / CHECKS

## Checks

- `themes check <dir>` MUST send only `theme.json`, `fields.json`,
  `logo.svg` and `README.md` from the folder root and MUST exit 2 with
  `THEME_INVALID` and one `issues[]` entry per error diagnostic when the
  Console reports errors. Warnings MUST NOT change the exit code.
- `themes publish` and `themes propose` without `--execute` MUST exit 3 with
  `WRITE_REQUIRES_EXECUTE` and a plan, after the Console check, and MUST NOT
  create a version or a proposal.
- `themes use <ref|none>` without `--execute` MUST exit 3 with the Console's
  plan (`from`, `to`, `affectedHosts`) and MUST NOT move the pointer.
- Inside an agent runtime, `themes publish` and `themes use` MUST exit 3 with
  `LIBRARY_AGENT_CANNOT_PUBLISH` or `LIBRARY_AGENT_CANNOT_SET_THEME` before
  any Console request.
- `themes init` MUST refuse to overwrite existing files without `--force`
  (`LIBRARY_FILES_EXIST`, exit 3, nothing written) and MUST write only the
  allowed theme paths.
- A reserved slug (`active`, `default`, `check`, `proposals`) MUST exit 2
  with `LIBRARY_SLUG_RESERVED` before any request.
- `themes active` MUST return the Console's `org`, `project` and `effective`
  pointers unchanged.
