# Widgets agent-first CLI contract / CHECKS

## Checks

- `widgets check <dir>` MUST send only `widget.html`, `widget.json`,
  `widget.js`, `example.json` and `README.md` from the folder root and MUST exit 2 with
  `WIDGET_INVALID` and one `issues[]` entry per error diagnostic.
- `widgets preview <dir>` MUST write the Console's HTML to `--out` (default
  `<dir>/preview.html`) only when there are no error diagnostics, and MUST
  write nothing otherwise.
- `widgets preview --theme none` MUST send `theme: "none"`, which renders
  Ravi's default theme.
- `widgets init --from-view` MUST reject a value that is not a uuid with
  `USAGE_ERROR` (exit 2) before any request, and MUST refuse to overwrite
  existing files without `--force` (`LIBRARY_FILES_EXIST`, exit 3). A
  symlink at a file's path, dangling or not, MUST be refused with
  `LIBRARY_FILES_EXIST` (exit 3) even with `--force`, writing nothing.
- `widgets show <reserved word>` (`catalog`, `check`, `preview`,
  `scaffold`, `proposals`, `none`) MUST exit 2 with `USAGE_ERROR` and the
  command the word stands for, before any request.
- `widgets publish`, `propose` and `init` with the slug `none` MUST exit 2
  with `LIBRARY_SLUG_RESERVED` before any request; `default` is a valid
  widget slug.
- `widgets publish` and `widgets propose` without `--execute` MUST exit 3
  with `WRITE_REQUIRES_EXECUTE` and a plan and MUST NOT write to the Library.
- Inside an agent runtime, `widgets publish` MUST exit 3 with
  `LIBRARY_AGENT_CANNOT_PUBLISH` before any Console request; `propose`,
  `check`, `preview`, `init` and `catalog` MUST work.
- `widgets init --from-view` of a view the Console does not find MUST exit
  1 with `NOT_FOUND` naming the Console project used and suggesting
  `--project <slug>`, writing nothing.
- Inside an agent, `LIBRARY_AGENT_CANNOT_PUBLISH` MUST name the propose
  command with the same folder; `LIBRARY_OUT_OF_VIEW` MUST name the org and
  project the session sees and carry them in `details.view`.
- An agent's Console project MUST resolve from its configured cwd's
  workspace default when the command runs in the daemon gateway (process
  cwd of the daemon).
- Through the daemon gateway, a Library refusal (`CONFLICT`,
  `LIBRARY_OUT_OF_VIEW`, `NOT_FOUND`, ...) MUST keep its code, message,
  `suggestedAction`, `conflict` and `view`, never "Remote command failed".
- `widgets catalog` MUST print the Console's agent text, and `--json` MUST
  include it as `text`.
- `widgets catalog --json` MUST carry `script` on every widget, `true` only
  when the Console says so.
- A `widget.js` diagnostic from the Console MUST print as
  `widget.js:line:column severity code message` and exit 2 with
  `WIDGET_INVALID`.
- `pages ship` whose only kit errors are `KIT_WIDGET_UNAUDITED` MUST exit 2
  with code `KIT_WIDGET_UNAUDITED`, upload nothing, and name the Console
  audit URL (only an `http(s)` URL) in `suggestedAction` and in each issue
  line; mixed with other kit errors it stays `KIT_INVALID`.
