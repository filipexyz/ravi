---
id: skills/library
title: "Library skills on the local runtime"
kind: capability
domain: skills
capabilities:
  - library
tags:
  - skills
  - library
  - console
  - search
  - proposals
applies_to:
  - src/library/
  - src/cli/commands/skills.ts
  - src/runtime/skill-authorization.ts
  - src/runtime/skill-capability-implication.ts
  - src/runtime/allowed-skills.ts
  - src/runtime/skill-visibility.ts
  - src/plugins/internal/ravi-system/skills/skills/SKILL.md
  - docs/reference/skills.mdx
owners:
  - ravi-dev
status: draft
normative: true
---

# Library skills on the local runtime

## Intent

The Library keeps skills in the hosted Console, for the whole organization or
for one project. This spec is the local half: how `ravi skills` searches the
Library, loads a published version on demand, keeps a copy that works offline,
publishes a folder, proposes a folder for review, reads proposals and their
review comments, and authorizes a Library skill for an agent. The Console
contract (HTTP API under `/api/cli/library`, JSON shapes, limits, error codes,
search ranking, who may publish or review) is the Console spec
`console/library`; this side only consumes it. There are no pinned skills and
no generated plugin yet: an agent reads a Library skill only through
`ravi skills show`.

## References

- An org item is `org/<slug>`; a project item is `<projectSlug>/<slug>`. `org`
  is a reserved project slug, so the two forms never collide.
- A slug is 1-64 characters of `a-z`, `0-9` and `-`, starting and ending with a
  letter or digit. Refs are case-insensitive and stored lowercase.
- The authorization id of an item is `org:<slug>` or
  `project:<projectSlug>:<slug>`. `ravi skills grant|revoke|who` accept either
  the ref or the id and store the id.
- A ref is never resolved against local skills, and an id is never matched
  against local skill names by slug, so `org/x` and a local skill `org-x` stay
  distinct.
- `proposals` is a reserved slug, like the Console's route words: a bare-slug
  show (`GET /skills/<slug>`) could never reach such an item, and a bare
  `ravi skills show proposals` never asks the Library.

## Resolution of `ravi skills show <name>`

1. A ref (`<scope>/<slug>`) goes to the Library item it names.
2. A bare name resolves locally first: Ravi's catalog skills, then installed
   skills. These always win over a Library item with the same slug.
3. A bare name with no local match that is a valid slug resolves in the
   Library view of the caller: org items plus the items of the Console project
   resolved for the caller (`resolveConsoleProjectRef` order: `--project`,
   runtime metadata, saved defaults, single visible project). No project
   resolved means org items only; that is not an error.
4. `--source` and `--installed` keep their local-only meaning.

Inside an agent runtime with a skill allowlist, the runtime skill gate checks
the name before the command runs and cannot know which Library item a bare
slug names, so agents use the full ref that `ravi skills search` returns in
`next`. The gate reads a ref (`ravi skills show org/x`) as that Library skill
and checks it with the Library rules below; `ravi skills publish|propose <dir>`
names a folder to send, not a skill to load, so its path is not checked as a
skill read.

## Authorization

Inside an agent runtime, a Library skill is authorized like a local skill:

- an agent with no skill configuration (grandfathered) passes;
- `admin:system:*` and `use:skill:*` (the `full-access` profile) pass;
- a grant whose stored id equals the item's id passes;
- a `use:skill:<id>` capability covering the id passes, with the same matcher
  as other capabilities (exact id or trailing glob: `use:skill:org:*`,
  `use:skill:project:*`, `use:skill:project:clinica:*`).

When the turn supplies its own capabilities, they are the ceiling, as for
local skills; explicit grants still apply. Library grants and Library
capabilities never authorize a local skill, never join the catalog a provider
announces, and do not count as skill configuration (granting a Library skill
does not narrow a grandfathered agent's local catalog). A project item of a
project other than the agent's resolved Console project is out of the agent's
view: it is refused (`LIBRARY_SKILL_OUT_OF_VIEW`, exit 3) unless a grant names
that exact id. Outside an agent runtime (operator terminal) `show` works as
before. A refusal is `SKILL_NOT_AUTHORIZED` (exit 1) and names the grant
(`ravi skills grant <agent> <ref>`) or the capability (`use:skill:<id>`).

## Turns with people outside the organization

Only the operator's own turns (terminal, the operator's linked direct chat,
the operator's routines) may load an item with `externalAllowed: false`. The
classification is the one `ravi pages read` uses (`resolveConnectorTurn`). In
any other turn `show` refuses with `LIBRARY_SKILL_EXTERNAL_DENIED` (exit 3,
policy) before printing or caching anything, and `search` leaves such items
out. `ravi skills publish --external` sets `externalAllowed: true`.

## Cache and offline behavior

- Every successful `show` writes the version it read under
  `<RAVI_STATE_DIR>/library/<orgId>/<scope>/<slug>@<version>/` (`<scope>` is
  `org` or the project slug) with an `item.json`, and records the item in
  `<RAVI_STATE_DIR>/library/<orgId>/index.json`. `search` records the items it
  returns in the same index, without their files.
- Writes are atomic (temporary file or directory, then rename). File paths
  from the Console are checked again before writing: relative, no empty, `.`
  or `..` segment.
- When the Console cannot be reached (`SERVER_UNAVAILABLE`, `HOST_UNREACHABLE`,
  `RATE_LIMITED`), `show` serves the newest cached version and `search` scores
  the index locally; both answer `stale: true` instead of failing. Any other
  Console error is not hidden by the cache.
- Not logged in (`ravi login`): Library parts are skipped with a hint; local
  skills still work. A ref then fails with `AUTH_REQUIRED`.

## Commands

### `ravi skills search <query>`

Flags: `--limit <n>` (default 10, at most 50), `--project <ref>`, `--local`
(skip the Console), `--json`. Local skills (catalog and installed) are scored
by a case- and accent-insensitive match of each query term over name and
description; Library items come from the Console search and are ordered with
the same scoring, local results first on ties. Each result has `ref`, `source`
(`system`, `installed` or `library`), `scope` (`org`, `project` or null for
local skills), `description`, `version` (library), `authorized` (only inside
an agent runtime) and `next` (`ravi skills show <ref>`). The payload carries
`library.status` (`ok`, `stale`, `skipped`, `error`) and `stale`.

### `ravi skills show <ref>`

Same output as a local show (`SKILL.md`, `--file`, `--raw`, `--json`), plus
`ref`, `scope`, `version` and `stale`. `--project <ref>` selects the project
for a bare slug.

### `ravi skills publish <dir> --scope org|<project>`

Flags: `--slug`, `--name`, `--note`, `--external`, `--execute`, `--json`.
Publishing changes what every agent of the org or project loads, so it follows
the write brake: without `--execute` it validates the folder, reads the
current published version and exits 3 with a plan (`ref`, `scope`, `project`,
`slug`, `files` with sizes, `totalBytes`, `contentHash`, `currentVersion`,
`nextVersion`, `unchanged`, `externalAllowed`). With `--execute` it publishes
with `baseVersion` equal to the version it read (0 for a new item). Local
checks, before any request: `SKILL.md` with a `description` in its
frontmatter, at most 100 files of UTF-8 text, 256 KiB per file and 1 MiB in
total, safe relative paths (`A-Z a-z 0-9 . _ - /`, at most 255 characters),
description at most 1024 characters, name at most 120, note at most 500.
Dot entries, `node_modules` and symlinks are not packaged. The slug defaults
to the frontmatter `name`, else the folder name. Slugs of Ravi's own skills
(catalog names and folder names) and the `ravi-` prefix are reserved.

### `ravi skills publish` inside an agent

Agents never publish. When `publish` runs in an agent runtime (a runtime
invocation with an agent id), it refuses before reading the folder or calling
the Console: `LIBRARY_AGENT_CANNOT_PUBLISH`, exit 3, with
`suggestedAction` `ravi skills propose <dir> --scope <scope> --execute`. The
operator's own terminal publishes as before. The Console refuses publish,
reject and revert calls that carry `agent`; both checks are cooperative, since
an agent shares its installation's `ravi login`.

## Drafts and proposals

A proposal is a version that is not published yet; a person who reviews the
scope publishes or rejects it in the Console. This is how an agent changes a
Library skill.

### `ravi skills propose <dir> --scope org|<project>`

Flags: `--slug`, `--name`, `--note`, `--external`, `--draft`,
`--update <number>`, `--rebase`, `--json`, `--execute` (last). The folder is
read and checked exactly like `publish`.

- Braked: without `--execute` it reads the published version (`GET
  /skills/<scope>/<slug>`) and either the item's proposals (new proposal) or
  the proposal to update (`--update`), then exits 3 with a plan: `ref`,
  `scope`, `project`, `slug`, `name`, `description`, `externalAllowed`,
  `note`, `files` with sizes, `totalBytes`, `contentHash`, `exists`,
  `currentVersion`, `baseVersion`, `submit` (true unless `--draft`), `update`,
  `proposal` (`number`, `status`, `round`, `baseVersion`, `stale`) for an
  update, `rebase`, `stale`, `unchanged`, `openProposals` (the caller's open
  proposals on the item; inside an agent, the ones that agent wrote), `agent`
  and an optional `hint`.
- A new proposal posts `POST /skills/proposals` with the publish body plus
  `submit: !draft` and `baseVersion` equal to the published version read (0
  when none).
- `--update <n>` posts `POST /skills/<scope>/<slug>/proposals/<n>/update` with
  the whole content again (files, `name`, `description`, `externalAllowed`,
  `note` when given). It sends `submit: true` only when the proposal is a
  draft and `--draft` is not passed, and sends `baseVersion` (the published
  version read) only with `--rebase`. Without `--rebase` the proposal keeps its
  base; when that base is behind the published version the plan says
  `stale: true` and its `hint` tells the author to read the new version, bring
  its changes into the folder and run again with `--rebase`.
- Local refusals before any write: `--rebase` without `--update`, an
  `--update` that is not a positive integer, and `--draft` on a proposal that
  already waits for review (`USAGE_ERROR`, exit 2); a closed proposal
  (`CONFLICT`, `conflict: proposal_closed`, exit 1); a proposal not written by
  this login, or inside an agent not written by this agent
  (`LIBRARY_PROPOSAL_NOT_YOURS`, exit 3); a proposal number the caller cannot
  see (`NOT_FOUND`, exit 1).
- Inside an agent runtime the body carries `agent: { id: <agentId> }`, and the
  target follows the agent's view: a project item of another project than the
  agent's Console project is refused (`LIBRARY_SKILL_OUT_OF_VIEW`, exit 3)
  unless a grant names that exact id. Proposing needs no skill grant and
  nothing beyond `ravi login`.
- Output: `✓ Proposed <ref> (proposal <n>), waiting for review`,
  `✓ Saved draft <ref> (proposal <n>)...` or `✓ Updated <ref> (proposal <n>,
  round <r>)...`, then the review link and `ravi skills proposal <ref> <n>` as
  the next step.
- Every proposal the CLI returns carries `reviewUrl`: the Console's
  `reviewPath` joined to the logged-in Console URL, or null when the Console
  sends none or a path that leaves its origin.
  `--json` returns `success`, `ref`, `number`, `status`, `round`,
  `baseVersion`, `currentVersion`, `stale`, `created`, `next` and `proposal`.

### `ravi skills proposals [ref]`

Read-only. Flags: `--project <ref>`, `--state open|closed|all` (default
`open`: `draft` and `proposed`), `--mine`, `--json`. With a ref it lists that
item's proposals (`GET /skills/<scope>/<slug>/proposals`, filtered by state
here); without one, every proposal the caller can see (`GET
/skills/proposals?project=&state=&mine=1`). Inside an agent runtime the list
is the agent's view: org items plus its Console project's (org items only when
none is resolved; `--project` naming another project is refused with
`LIBRARY_SKILL_OUT_OF_VIEW`), and `--mine` keeps what that agent wrote. In a
turn that is not the operator's own, proposals not marked `externalAllowed`
are left out. Each row shows ref, number, status, `[stale]`, the author
(`agent X for Y` when an agent wrote it) and open comments; `--json` rows add
`next` (`ravi skills proposal <ref> <n>`).

### `ravi skills proposal <ref> <number>`

Read-only (`GET /skills/<scope>/<slug>/proposals/<n>`). It shows status,
round, base and published version, `stale`, note, decision and reason, the
files (path and size; contents only in `--json`) and the review comments
(`path:line`, an outdated marker with the round it was made on, a resolved
marker, author and body, replies under their comment). `--json` returns
`ref`, `number`, `item` (`version` null while nothing is published),
`proposal`, `files` (`path`, `bytes`, `sha256`, `content`), `base` (`number`
and files without contents) or null, `comments` and `contentsVisible`.
Inside an agent runtime, file contents are included only for a proposal that
agent wrote or a skill it is authorized to load (`contentsVisible: false`
otherwise), and the agent's view applies as for `proposals`. In a turn that is
not the operator's own, a proposal not marked `externalAllowed` is refused
with `LIBRARY_SKILL_EXTERNAL_DENIED` (exit 3).

### Console conflicts

`CONFLICT` answers keep the Console code and exit 1. The contract envelope
redacts a `reason` key as free text, so the reason travels as
`details.conflict` (and `details.reason`), with a `suggestedAction` per
reason: `stale_base` (publish: plan again; propose: read the new version and
plan again, `--rebase` with `--update`), `unchanged` (nothing to propose),
`slug_taken_in_org`, `slug_taken_in_project` and `slug_reserved` (another
`--slug`), `proposal_closed` (propose again without `--update`).

## Error codes

| case | code | exit |
| --- | --- | --- |
| malformed ref, slug or `--scope` | `LIBRARY_REF_INVALID` | 2 |
| folder fails a local check | `LIBRARY_PACKAGE_INVALID` | 2 |
| reserved slug | `LIBRARY_SLUG_RESERVED` | 2 |
| item missing or not visible | `SKILL_NOT_FOUND` | 1 |
| agent not authorized | `SKILL_NOT_AUTHORIZED` | 1 |
| project item outside the agent's view | `LIBRARY_SKILL_OUT_OF_VIEW` | 3 |
| `externalAllowed: false` in a turn that is not the operator's own | `LIBRARY_SKILL_EXTERNAL_DENIED` | 3 |
| publish or propose without `--execute` | `WRITE_REQUIRES_EXECUTE` | 3 |
| publish inside an agent runtime | `LIBRARY_AGENT_CANNOT_PUBLISH` | 3 |
| `--rebase` without `--update`, bad `--update`, `--draft` on a proposed proposal, bad `--state` or proposal number | `USAGE_ERROR` | 2 |
| `--update` of a proposal by another author (or, inside an agent, another agent) | `LIBRARY_PROPOSAL_NOT_YOURS` | 3 |
| `--update` of a closed proposal | `CONFLICT` (`conflict: proposal_closed`) | 1 |
| proposal missing or not visible | `NOT_FOUND` | 1 |
| Console errors (`AUTH_REQUIRED`, `CONFLICT` with `details.conflict`, ...) | Console code | per the cloud mapping |
