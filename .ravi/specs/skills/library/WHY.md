# Library skills on the local runtime / WHY

Until 2026-10-13 a skill lived only on one daemon's disk (the catalog shipped
with Ravi, or folders installed with `ravi skills install`). An organization
had nowhere to keep the procedures its agents share, and agents could not
search for a skill. The Console Library (spec `console/library`) is that
place; this side lets a local Ravi use it. Luís approved the design study
("Skills e agents por org e projeto") with these decisions that shape the
local half:

- The Console is the source of truth and the daemon only caches. A copy of
  what was loaded keeps working offline, so a Console outage does not take a
  skill away from an agent in the middle of its work.
- Refs are `org/<slug>` and `<projectSlug>/<slug>`. A bare slug resolves
  locally first: Ravi's own skills and installed skills always win, and Ravi's
  skill names are reserved, so an agent never loads an organization's skill
  where it expects Ravi's own.
- Library skills are authorized like local skills (decision 9). The ids
  `org:<slug>` and `project:<projectSlug>:<slug>` were chosen so the existing
  trailing-glob matcher gives `use:skill:org:*` and `use:skill:project:*`
  without new syntax. They never fall back to slug matching, because
  `org:x` and a local `org-x` would otherwise collide.
- Only skills marked for it reach turns with people outside the organization
  (decision 10). The turn classification is the one `ravi pages read` already
  trusts for private Pages, so there is one rule for "the operator's own
  turn".
- Delivery is on demand through `search` and `show` (decision 11). Pinned
  skills and a generated plugin are phase 3.
- Publishing reaches every agent of the org or project, so it carries the
  write brake. The plan reads the current version first, and `--execute`
  sends it as `baseVersion`, so two people publishing at once get a
  `stale_base` conflict instead of overwriting each other.

The runtime skill gate checks a skill name before `ravi skills show` runs.
It cannot know which Library item a bare slug names without a network call,
and making it lenient for unknown names would also let a disk-only skill
through Read. Agents therefore use the full ref, which `search` always
returns in `next`.
