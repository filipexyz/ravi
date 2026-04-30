---
id: plugins
kind: domain
status: draft
---

# Why Plugins

## Problem the domain solves

Before plugins, capability content (the rules, CLIs, pipelines an agent uses) was inlined inside each agent's `AGENTS.md`. The same Pipeline ISDPIP rules, the same 130 CLI lists, the same locale rules were copy-pasted across agents and across `SKILL.md` files. This created three failure modes:

1. **Context bloat** — every agent loaded the full content into the runtime turn even when the prompt did not need it. The Claude Code provider already supports progressive disclosure via Skills; inlined content defeats that mechanism.
2. **Drift** — when a rule changed, the operator had to edit the rule in N places and inevitably missed one. The duplicated rule then quietly disagreed with itself.
3. **No distribution path** — there was no way to ship a capability to a peer without copying files by hand. There was also no version on the capability, so "the same skill" on two machines could behave differently.

Plugins decouple identity (agent) from capability (plugin), and give the runtime a single packaging unit that the harness already knows how to discover.

## Why two sources (internal + user)

Internal plugins ship inside the Ravi binary so that core capabilities (system commands, dev skills, prox flow) cannot be partially upgraded — they move with the runtime release. User plugins live at `~/ravi/plugins/` so that operators can install or modify capabilities without rebuilding the binary.

The two-source split also keeps blast radius bounded: an operator who breaks a user plugin only breaks their own session; they cannot brick the runtime by editing a path that ships with the binary, because internal extraction overwrites the cache directory on every start.

## Why plugin ≠ skill

The earliest version of this design treated plugin and skill as the same word. That made every skill a top-level distribution unit and forced operators to publish 100 plugins to ship 100 skills. The container/content split was adopted because:

- Multiple related skills usually share ownership and version cadence (e.g. all `ads` skills move together).
- Commands, hooks, and agents — which are not skills — also need a distribution unit.
- A plugin manifest is the right place to declare external dependencies (allowed-tools defaults, MCP servers, hooks) without duplicating them per skill.

## Why scope is currently global

The current implementation returns every discovered plugin to every session via `discoverPlugins()` (see `src/plugins/index.ts`). That is acceptable because:

- The set of plugins on a given machine is small and operator-controlled.
- Skill discovery is gated by the skill `description` matching the prompt, so non-relevant skills do not auto-invoke.

It becomes a problem when the catalog grows past dozens of skills per agent — at that point, even the description payload at session start becomes context-relevant noise. The proposed `runtime-sync` capability addresses this by making per-agent scope a runtime concern rather than a discovery concern.

## Alternatives considered

- **Skills directly in `~/.claude/skills/`** — works, but loses versioning and grouping. Acceptable for personal/experimental skills; insufficient for shared capabilities.
- **One monolithic plugin per machine** — collapses to the AGENTS.md problem with extra ceremony. Rejected.
- **Per-agent skill directories with no plugin layer** — works for the static case, but breaks distribution and forces operators to copy files manually across machines. Acceptable as an intermediate state, not a target.
