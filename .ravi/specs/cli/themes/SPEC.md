---
id: cli/themes
title: "Themes agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - themes
tags:
  - cli
  - themes
  - library
  - console
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
applies_to:
  - src/cli/commands/themes.ts
  - src/cli/library-contract.ts
  - src/library/presentation.ts
  - src/library/kinds.ts
  - src/library/package.ts
  - src/library/diagnostics.ts
  - src/plugins/internal/ravi-system/skills/pages/references/theme.md
  - docs/console/widgets.mdx
owners:
  - ravi-dev
status: draft
normative: true
---
# Themes agent-first CLI contract

## Intent

`ravi themes` is the local side of the Console Library's `theme` kind: it
reads a theme folder, sends it to the Console, writes the Console's default
files, and reads or sets the organization's and projects' active theme.
Transport only, under the global contract in [`../SPEC.md`](../SPEC.md): the
Console compiles tokens, measures contrast, resolves pointers and decides who
may publish or set them. Publish, propose and proposals share the Library
behavior of `skills/library` and [`../skills/SPEC.md`](../skills/SPEC.md)
with `kind: "theme"`; `ravi widgets` ([`../widgets/SPEC.md`](../widgets/SPEC.md))
is the same shape for widgets.

## Invariants

1. Every op follows the global envelope and exit taxonomy: `0` success, `1`
   execution or not found, `2` usage or invalid folder, `3` policy brake or
   refusal.
2. A folder holds only `theme.json` (required, the entry), `fields.json`,
   `logo.svg` and `README.md`, read at its root; other files are left out and
   never sent. Each file is a regular UTF-8 file within the Library's per-file
   limit (`LIBRARY_PACKAGE_INVALID`, exit 2, otherwise).
3. `check`, `publish` and `propose` send the files to the Console check. Any
   error diagnostic is `THEME_INVALID` (exit 2) with one `issues[]` entry per
   diagnostic (`path = [file, line, column]`) and the failing contrast pairs;
   text output prints `file:line:column severity code message` per line.
   Warnings never fail.
4. `publish` and `propose` need a description (`theme.json` `$description`,
   `LIBRARY_PACKAGE_INVALID` otherwise). The slug is `--slug`, else the folder
   name; `active`, `default`, `none`, `check` and `proposals` are
   `LIBRARY_SLUG_RESERVED` (exit 2) before any request (the Console reserves
   the same words; `none` and `default` are what theme refs mean by them).
5. `init` writes exactly the files the Console's default theme returns, only
   allowed paths, and never overwrites without `--force`
   (`LIBRARY_FILES_EXIST`, exit 3, nothing written). A target path that is
   not a regular file (a folder, or a symlink, dangling or not, checked with
   `lstat`) is `LIBRARY_FILES_EXIST` (exit 3) even with `--force`; nothing is
   written through it, and new files are created exclusively (`wx`).
6. `use <ref|none>` sets the org pointer, or the project pointer with
   `--project` or a `<project>/<slug>` ref; `none` clears it. Without
   `--execute` it returns the Console's dry-run plan (`scope`, `project`,
   `from`, `to`, `affectedHosts`, plus `unchanged`) with exit 3 and writes
   nothing. `plan.project` is the Console's `{ id, slug, name }` (null for
   the org pointer); text output names it `slug (name)`. When the pointer
   already names the target the Console answers `applied: true, unchanged:
   true` and writes nothing: the CLI reports `applied: false, unchanged:
   true` and prints `= Nothing changed`, never a save.
7. Inside an agent runtime, `publish` and `use` refuse before any request:
   `LIBRARY_AGENT_CANNOT_PUBLISH` (with `ravi themes propose <dir> --scope
   <scope> --execute`) and `LIBRARY_AGENT_CANNOT_SET_THEME` (with `Ask the
   operator to run: ravi themes use <ref> --execute`), both exit 3. An agent's
   `--project` other than its own Console project is `LIBRARY_OUT_OF_VIEW`
   (exit 3).
8. `active` returns `{ projectRef, org, project, effective, warnings }` as
   the Console sent them.
9. `show <slug>` with a reserved word (invariant 4) as a bare slug is
   `USAGE_ERROR` (exit 2) before any request, with the command that word
   stands for as `suggestedAction` (`active` → `ravi themes active`,
   `default` → `ravi themes init <dir>`): the Console routes those words to
   other endpoints, never to an item.

## Write classification

| invocation | actual effect | confirmation |
|---|---|---|
| search / show / proposals / proposal / active | read | immediate |
| check | read: Console compile and contrast, no write | immediate |
| init | local files in the folder, refuses to overwrite without `--force` | immediate (`LIBRARY_FILES_EXIST` exit 3 on existing files) |
| publish | a new version the org's or project's pages pick up | dry-run exit 3 with the plan (after the Console check), then `--execute` |
| propose (new, `--update`, `--draft`) | a draft or a proposal reviewers are notified of | dry-run exit 3 with the plan, then `--execute` |
| use | the active theme of every page of the org or project | dry-run exit 3 with the Console's plan, then `--execute` |
| publish or use inside an agent runtime | none | refused, exit 3 |

## Official error cases

| case | code | exit |
|---|---|---|
| folder missing, not a folder, no `theme.json`, bad file, no description | `LIBRARY_PACKAGE_INVALID` | 2 |
| Console check reports errors (tokens, contrast, fields, logo) | `THEME_INVALID` + diagnostics | 2 |
| malformed ref or `--scope` | `LIBRARY_REF_INVALID` | 2 |
| reserved slug | `LIBRARY_SLUG_RESERVED` | 2 |
| bad flag value (`--limit`, `--version`, `--project`) | `USAGE_ERROR` | 2 |
| `show` of a reserved word as a bare slug | `USAGE_ERROR` + the command it stands for | 2 |
| unknown theme | `THEME_NOT_FOUND` + `ravi themes search` | 1 |
| `init` onto existing files, or onto a symlink or folder at a file's path | `LIBRARY_FILES_EXIST` | 3 |
| publish, propose or use without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |
| publish or use inside an agent | `LIBRARY_AGENT_CANNOT_PUBLISH`, `LIBRARY_AGENT_CANNOT_SET_THEME` | 3 |
| `--update` of another author's or agent's proposal | `LIBRARY_PROPOSAL_NOT_YOURS` | 3 |
| agent `--project` outside its view | `LIBRARY_OUT_OF_VIEW` | 3 |
| stale base, unchanged, slug taken, proposal closed | `CONFLICT` with `conflict` | 1 |
| no Ravi Cloud login | `AUTH_REQUIRED` | 1 |

## Internal consumers

The pages skill `references/theme.md` and `docs/console/widgets.mdx` teach
these commands; `pages ship --theme` and `pages outdated` are
[`../pages/SPEC.md`](../pages/SPEC.md). `src/cli/execute-consumers.test.ts`
pins the braked examples in help, skill and docs.

## Validation

- `bun test src/cli/commands/themes.test.ts src/library/` and
  `bun test src/cli/execute-consumers.test.ts`.
- Live checks with an isolated `HOME`: `themes check` on a folder with a
  failing pair exits 2; `themes publish` and `themes use` without
  `--execute` exit 3; inside an agent context both refuse with exit 3 before
  any request.

## Known Failure Modes

- A publish or proposal the Console's compiler rejects answers
  `400 PAYLOAD_INVALID` with the lines in `details.diagnostics`. Mapped as a
  plain cloud error it would lose them; the CLI turns it into
  `THEME_INVALID` (exit 2) with `issues[]`, because the remote gateway
  projects only `issues`.
