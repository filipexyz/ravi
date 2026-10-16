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
  skills and a generated plugin came in phase 3.
- Publishing reaches every agent of the org or project, so it carries the
  write brake. The plan reads the current version first, and `--execute`
  sends it as `baseVersion`, so two people publishing at once get a
  `stale_base` conflict instead of overwriting each other.

The runtime skill gate checks a skill name before `ravi skills show` runs.
It cannot know which Library item a bare slug names without a network call,
and making it lenient for unknown names would also let a disk-only skill
through Read. Agents therefore use the full ref, which `search` always
returns in `next`.

## Phase 2: proposals (2026-10-16)

Luís approved that agents never publish. An agent that improves a skill
proposes a new version; a person who reviews the scope comments on it, then
publishes or rejects it in the Console. So `ravi skills publish` refuses in an
agent runtime before any request, and `ravi skills propose` is the agent's
path. The refusal is cooperative (an agent shares its installation's
`ravi login`), which is why the Console also refuses publish, reject and
revert calls that carry `agent`.

- `propose` keeps the write brake: a proposal notifies the scope's reviewers,
  so the plan comes first. It shows the caller's own open proposals on the
  item, so an agent updates its proposal instead of opening another.
- An update keeps its base unless `--rebase` is passed. Moving a proposal onto
  a newer version without reading that version would silently drop someone
  else's published change; the stale hint asks the author to read it first.
- An agent updates only proposals it wrote, even though the Console sees the
  same user for every agent of an installation and the person.
- Proposal reads follow the same limits as loading a skill: the agent's view
  (org plus its project), no proposal not marked `externalAllowed` in a turn
  that is not the operator's own, and file contents only for the agent's own
  proposals or skills it may load.
- The contract envelope redacts `reason` keys as free text, so Console
  conflict reasons travel as `conflict`.

## Phase 3: pins (2026-10-16)

Some skills an agent should always have, without searching: the tone of voice
of a clinic's attendant, the triage procedure of its project. A person pins a
Library skill to an agent of an installation in the Console, and the agent
loads it natively, like Ravi's own skills.

- The Console decides who may pin and keeps the pins; the daemon only reports
  its agents, reads the pins and enforces them locally. Pins live per
  installation because agent ids are only unique inside one daemon. The
  report carries each agent's Console project so the Console can refuse a
  project skill for an agent outside that project (`agent_out_of_scope`)
  without the daemon judging it.
- The runner polls (5 minutes by default) instead of waiting for a push: the
  daemon already polls the Console for its inbox, a pin is not urgent, and the
  pin and unpin commands refresh right away. The fingerprint, not only the
  Console's `revision`, decides whether anything changed, so a new published
  version of a pinned item is picked up even if the revision did not move.
- A pinned skill must reach only its agent, but the providers differ. Claude
  takes skills only as an allowlist (no deny list) and Pi only advertises
  plugin skills, so each session gets a plugin holding only its agent's
  pins. Codex copies every plugin skill into one shared `~/.codex/skills`; a
  per-agent plugin there would make each session delete the others' copies,
  so Codex gets the installation's union and each thread disables the skills
  that are not its own through `skills.config`, which works with or without
  an allowlist.
- `externalAllowed` is enforced the same way: a second per-agent plugin holds
  only the pins marked for it, chosen when the session starts from the same
  turn classification `show` uses. A session's plugin set is fixed when it
  starts, so the classification is too.
- Pins authorize like grants, through plugin-qualified names only
  (`ravi-library:<name>`), so a pin never lets a same-named local skill
  through, and they do not configure the agent, so pinning does not narrow a
  grandfathered agent's catalog.
- Generations are immutable directories, renamed into place and pruned only
  after two newer ones exist, so a session never reads half-written files.
- Agents do not pin or unpin, for the reason they do not publish: a pin
  changes what an agent always loads. Unpinning reduces authority, so it runs
  without `--execute`, and a failed refresh after it still removes the pin
  locally.
- The sync answer has no files, so the daemon downloads each pinned version
  with the login's read access. A project item the login cannot read is
  reported as `LIBRARY_PIN_UNAVAILABLE` and retried, rather than loaded from
  somewhere the Console did not authorize.

## Phase 4: agent definitions (2026-10-16)

- The Console already versions agent definitions with the skill routes under
  `agents/`. The local side reuses the client, cache and contract helpers with
  a kind switch instead of a second stack, and keeps the agent cache apart so
  a skill and an agent with the same slug never collide.
- The brake is decided here, not by the Console: what adds authority on this
  machine is a permission profile above the bootstrap floor and a skill
  grant, the same rule as `ravi agents permissions` and `ravi skills grant`.
  A definition that only brings instructions, a provider and a model is a
  reversible local write and applies at once.
- `update` records a hash of each file as installed so it can tell an
  untouched file (follow the Library) from a local edit (ask). Kept files keep
  their installed hash, so a later update asks again instead of silently
  overwriting.
- An update applies a profile only when the definition changed its
  suggestion: the operator may have lowered it on purpose.
- `publish` builds `agent.json` from what is configured here and sends only
  Library skill refs the scope can see. Local skill names, routes, instances,
  contacts and paths mean nothing on another machine and may be private.
- Agents do not install, update or publish agents: these change or share the
  machine's authority, the operator's call (same reasoning as pins).
