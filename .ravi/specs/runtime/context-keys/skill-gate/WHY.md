# Skill-Gated Tool Invocation Rationale

## Why The Gate Trusts The Vector

A gated tool must not run before its specialist skill is in the agent's working
context. Prompts and per-CLI reminders are advisory: a session can compact,
skip discovery, or narrate "I loaded the skill" without it being true. The
runtime therefore trusts only the `loadedSkills` vector held by
`runtime/skill-loading`, never natural language and never presence on disk.

## Why Soft Gate With Auto-Inject

Denying and delivering the skill in the same response turns the denial into
the load. The first call is rejected, the skill content rides along in the
error payload, and the marker is recorded so the very next attempt passes. A
hard gate would leave the agent to discover the skill on its own; a passive
inject would run the tool before the agent read the content. Neither variant
is exposed as an operator choice until a later revision proves the need.

## Why Loaded Markers Are Matched By Logical Skill

One skill has several physical identities. Gate rules carry the
plugin-qualified catalog alias (`ravi-system-pages`) because that is how the
first-party group defaults are declared. Provider snapshots advertise, and
`ravi skills show` records, the plugin short id (`pages`), which is also the
frontmatter `name`.

Comparing the two strings literally makes the gate deny forever: the denial
marks `ravi-system-pages`, the agent follows the instruction and loads `pages`,
the retry finds only `pages` in the vector, and the skill is delivered again
on every attempt. The gate therefore treats the canonical name, its managed
plugin aliases (`ravi-system-*`, `ravi-dev-*`, `ravi-user-skills-*`) and the
physical aliases of the resolved skill as the same logical skill.

## Why The Hot Path Stays A Pure String Comparison

Equivalence is decided with slugs and known managed prefixes, not by looking
the skill up. The allow path runs on every gated call and must not touch the
filesystem or the plugin catalog. Alias resolution through the catalog is
allowed only on the denial path, where the skill is already being resolved to
deliver its content, so accepting the resolved skill's physical aliases there
costs nothing extra.

## Why One Logical Skill Keeps One Visibility Record

When the gate marks the delivered skill as loaded, it updates the record the
session already holds for that logical skill (the advertised `pages` record)
instead of appending a second record under the gate alias. Two records for one
skill would make `ravi sessions visibility` disagree with itself and would let
one alias read `loaded` while the other stays `advertised`.

## Alternatives Rejected

- Storing the catalog alias when marking loaded was rejected because it only
  repairs the gate's own marker. The manual load path (`ravi skills show
  pages`) and provider snapshots still record the short id, so the retry after
  a manual load would keep failing.
- Rewriting every gate rule to the short id was rejected because operators
  already declare rules with catalog aliases and the alias is the stable,
  collision-free identity across plugins.
- Resolving aliases through the catalog on every call was rejected because the
  hot path must stay read-only and free of filesystem work.
- Matching by prefix alone (`endsWith`) was rejected because `tasks` must not
  satisfy a gate for `ravi-system-tasks-eval`; equivalence strips only the
  known managed prefixes.
