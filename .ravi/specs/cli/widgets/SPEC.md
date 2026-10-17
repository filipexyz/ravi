---
id: cli/widgets
title: "Widgets agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - widgets
tags:
  - cli
  - widgets
  - library
  - console
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
applies_to:
  - src/cli/commands/widgets.ts
  - src/cli/library-contract.ts
  - src/library/presentation.ts
  - src/library/kinds.ts
  - src/library/package.ts
  - src/library/diagnostics.ts
  - src/plugins/internal/ravi-system/skills/pages/references/widgets.md
  - docs/console/widgets.mdx
owners:
  - ravi-dev
status: draft
normative: true
---
# Widgets agent-first CLI contract

## Intent

`ravi widgets` is the local side of the Console Library's `widget` kind: it
reads a widget folder, sends it to the Console to check, preview or publish,
writes the Console's scaffold, and prints the catalog agents read before
writing a widget or a page with `ravi-*` tags. Transport only: the Console
compiles templates, runs the accessibility lint, matches fields and renders
previews. Shared rules (envelope, publish and propose, agent refusals,
proposals) are those of [`../themes/SPEC.md`](../themes/SPEC.md) with
`kind: "widget"`; this file lists what differs.

## Invariants

1. A folder holds only `widget.html` (the entry), `widget.json`,
   `widget.js`, `example.json` and `README.md`, read at its root; anything
   else (`preview.html`, other `.js` files) is left out. `widget.js` is
   optional and sent as is by `check`, `preview`, `publish` and `propose`:
   the Console parses it (one ES module up to 128 KiB, no imports, an
   exported `mount`) and reports `WIDGET_JS_*` diagnostics at
   `widget.js:line:column` under `WIDGET_INVALID`. `init` writes only what
   the Console scaffold returns (no `widget.js`). `show` lists `widget.js`
   with its size and never prints it. `publish` and `propose` require
   `widget.html` and `widget.json` with `name` and `description`
   (`LIBRARY_PACKAGE_INVALID`, exit 2). Reserved slugs
   (`LIBRARY_SLUG_RESERVED`, exit 2, before any request): `catalog`,
   `check`, `preview`, `scaffold`, `proposals`, and `none` (what
   `ravi bases views bind ... none` reads as unbind); `default` is not
   reserved for widgets. `show` of one as a bare slug is
   `USAGE_ERROR` (exit 2) before any request, with the command it stands for
   (`catalog` → `ravi widgets catalog`).
2. Any error diagnostic of `check`, `preview`, `publish`, `propose` or
   `init` is `WIDGET_INVALID` (exit 2), one `issues[]` entry per diagnostic
   with `path = [file, line, column]`.
3. `catalog` prints the Console's agent text (`--json`: the catalog with its
   `text`), with the org's and the caller's project widgets. Each `--json`
   widget carries `script` (boolean: the current version has `widget.js`;
   `false` when the Console omits it); the text marks those widgets "com
   código" as the Console writes it.
4. `init <dir>` asks the Console scaffold for `--slug` (default: the folder
   name) and, with `--from-view <view-uuid>`, the view's schema as the
   caller, never rows. A non-uuid view is `USAGE_ERROR` (exit 2). Existing
   files are kept unless `--force` (`LIBRARY_FILES_EXIST`, exit 3); a
   symlink or folder at a file's path is refused even with `--force`, as in
   `themes init`.
5. `preview <dir>` writes the Console's script-free HTML to `--out` (default
   `<dir>/preview.html`), with `--data <file>` (one JSON object or
   `{ "records": [...] }`, `USAGE_ERROR` otherwise) and `--theme <ref>`
   (`none` is sent as is and renders Ravi's default theme); without
   `--theme` the Console uses the effective theme.
6. Inside an agent runtime `publish` refuses before any request
   (`LIBRARY_AGENT_CANNOT_PUBLISH` with `ravi widgets propose <dir> --scope
   <scope> --execute`, exit 3); `propose`, `check`, `preview`, `init` and
   `catalog` work. An agent's `--project` other than its own Console project
   is `LIBRARY_OUT_OF_VIEW` (exit 3).
7. Binding a widget to a view is `ravi bases views bind` (`cli/bases`):
   an immediate view update, not a Library write.
8. A widget version with `widget.js` is published only by an org `owner` or
   `admin`; the Console refuses anyone else with
   `LIBRARY_SCRIPT_REQUIRES_ORG_ADMIN` (403, `ORG_ACCESS_DENIED` on the CLI)
   and `propose` stays open. Until the Console's accessibility audit of the
   version passes, `ravi pages ship` of a page that uses it exits 2 with
   `KIT_WIDGET_UNAUDITED` and the Console audit URL in `suggestedAction`
   (`cli/pages`).

## Write classification

| invocation | actual effect | confirmation |
|---|---|---|
| search / show / catalog / proposals / proposal | read | immediate |
| check | read: Console compile and lint, no write | immediate |
| init | local files in the folder, no overwrite without `--force` | immediate (`LIBRARY_FILES_EXIST` exit 3 on existing files) |
| preview | one local HTML file | immediate |
| publish | a new version pages pin on their next ship | dry-run exit 3 with the plan (after the Console check), then `--execute` |
| propose (new, `--update`, `--draft`) | a draft or a proposal reviewers are notified of | dry-run exit 3 with the plan, then `--execute` |
| publish inside an agent runtime | none | refused, exit 3 |

## Official error cases

| case | code | exit |
|---|---|---|
| folder missing, no `widget.html`, bad file; publish without `widget.json` or description | `LIBRARY_PACKAGE_INVALID` | 2 |
| template, manifest, example, `widget.js` or accessibility errors | `WIDGET_INVALID` + diagnostics | 2 |
| publish of a version with `widget.js` by someone not org owner or admin | `ORG_ACCESS_DENIED` (Console `LIBRARY_SCRIPT_REQUIRES_ORG_ADMIN`) | 1 |
| `pages ship` with a widget whose `widget.js` has no passing audit | `KIT_WIDGET_UNAUDITED` + audit URL in `suggestedAction` | 2 |
| bad `--slug`, `--from-view`, `--data` or `--theme`; `show` of a reserved word | `USAGE_ERROR` | 2 |
| reserved slug | `LIBRARY_SLUG_RESERVED` | 2 |
| malformed ref or `--scope` | `LIBRARY_REF_INVALID` | 2 |
| unknown widget | `WIDGET_NOT_FOUND` + `ravi widgets search` | 1 |
| `init` onto existing files, or onto a symlink or folder at a file's path | `LIBRARY_FILES_EXIST` | 3 |
| publish or propose without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |
| publish inside an agent | `LIBRARY_AGENT_CANNOT_PUBLISH` | 3 |
| `--update` of another author's or agent's proposal | `LIBRARY_PROPOSAL_NOT_YOURS` | 3 |
| agent `--project` outside its view | `LIBRARY_OUT_OF_VIEW` | 3 |
| stale base, unchanged, slug taken, proposal closed | `CONFLICT` with `conflict` | 1 |

## Internal consumers

The pages skill `references/widgets.md` (tags, ship, when to create a
widget) and `docs/console/widgets.mdx`. Tags and the page kit are
[`../pages/SPEC.md`](../pages/SPEC.md); `src/cli/execute-consumers.test.ts`
pins the braked examples.

## Validation

- `bun test src/cli/commands/widgets.test.ts src/library/` and
  `bun test src/cli/execute-consumers.test.ts`.
- Live checks with an isolated `HOME`: `widgets check` on a template with an
  image without `alt` exits 2 with `A11Y_IMAGE_ALT` at its line;
  `widgets publish` without `--execute` exits 3; inside an agent context it
  refuses with exit 3 before any request.

## Known Failure Modes

- A preview always has a theme: `--theme none` renders Ravi's default theme,
  not an unstyled page, because the pieces need the theme's variables.
