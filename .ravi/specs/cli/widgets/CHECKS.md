# Widgets agent-first CLI contract / CHECKS

## Checks

- `widgets check <dir>` MUST send only `widget.html`, `widget.json`,
  `example.json` and `README.md` from the folder root and MUST exit 2 with
  `WIDGET_INVALID` and one `issues[]` entry per error diagnostic.
- `widgets preview <dir>` MUST write the Console's HTML to `--out` (default
  `<dir>/preview.html`) only when there are no error diagnostics, and MUST
  write nothing otherwise.
- `widgets preview --theme none` MUST send `theme: "none"`, which renders
  Ravi's default theme.
- `widgets init --from-view` MUST reject a value that is not a uuid with
  `USAGE_ERROR` (exit 2) before any request, and MUST refuse to overwrite
  existing files without `--force` (`LIBRARY_FILES_EXIST`, exit 3).
- `widgets publish` and `widgets propose` without `--execute` MUST exit 3
  with `WRITE_REQUIRES_EXECUTE` and a plan and MUST NOT write to the Library.
- Inside an agent runtime, `widgets publish` MUST exit 3 with
  `LIBRARY_AGENT_CANNOT_PUBLISH` before any Console request; `propose`,
  `check`, `preview`, `init` and `catalog` MUST work.
- `widgets catalog` MUST print the Console's agent text, and `--json` MUST
  include it as `text`.
