---
id: plugins
title: "Plugins"
kind: domain
domain: plugins
capabilities:
  - locations
  - runtime-sync
  - migration
tags:
  - plugins
  - skills
  - extensibility
  - claude-plugin
applies_to:
  - src/plugins
  - src/plugins/internal
  - src/plugins/internal-loader.ts
  - src/skills/manager.ts
  - src/plugins/codex-skills.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Plugins

## Intent

Plugins are the canonical packaging unit Ravi uses to extend agent capabilities. A plugin bundles skills, commands, agents, and hooks under a single manifest so that the runtime can discover, version, and distribute them through a predictable filesystem contract.

The plugin domain exists so that capability content (skills, commands) is decoupled from agent identity (`AGENTS.md`). Agents declare *who they are*; plugins declare *what they can do*.

## Boundaries

- **Plugin** is the container. It MUST have a `.claude-plugin/plugin.json` manifest.
- **Skill** is a unit of capability inside a plugin (or in a flat skills directory). It lives in `<plugin>/skills/<skill-name>/SKILL.md`.
- A plugin MAY contain zero or many skills, plus other artifacts (commands, agents, hooks). The plugin domain governs the container; the runtime/skills capability governs how skills are loaded and tracked at session time.
- Plugins MUST NOT duplicate skill content into agent `AGENTS.md`. If content lives in a `SKILL.md`, the agent file references the skill by name and lets discovery resolve it.

## Rules

- A plugin MUST have a `.claude-plugin/plugin.json` manifest with at least `name`, `version`, and `description`.
- A plugin's skills MUST live under `<plugin-root>/skills/<skill-name>/SKILL.md`.
- A skill `description` field MUST be treated as the discovery contract: it is the only signal the harness uses to decide whether to auto-load the skill on a matching prompt. Vague descriptions break discovery.
- The runtime MUST discover plugins from two canonical sources, in order:
  1. **Internal plugins** — embedded in the Ravi binary, extracted on start to `~/.cache/ravi/plugins/<name>/`. These MUST NOT be edited manually; they are regenerated every runtime start.
  2. **User plugins** — operator-installed at `~/ravi/plugins/<name>/`. These MUST persist across restarts and are the operator's source of truth.
- A plugin directory without `.claude-plugin/plugin.json` MUST be ignored by user-plugin discovery (silent skip with debug log, never an error).
- Plugins MUST NOT be discovered from arbitrary cwds today. Per-agent local plugins (`<agent-cwd>/.ravi/plugins/`) are a proposed extension governed by the `runtime-sync` capability and MUST NOT be assumed active without explicit implementation.
- The default user-plugin name reserved for operator-installed skills with no explicit container is `ravi-user-skills`; new operator skills SHOULD install into this plugin unless a domain-specific plugin already exists.
- Plugins MUST NOT mutate state outside of their own directory at discovery time. Side effects (caches, indexes) MUST live in `~/.cache/ravi/plugins/` or under explicit Ravi-owned paths.

## What Plugins Are Not

- Plugins are NOT a replacement for `AGENTS.md`. The agent file remains the source of truth for identity, fluxo de entrada, anti-loop, and cross-agent delegation rules.
- Plugins are NOT permission grants. A plugin shipping a skill does not by itself authorize an agent to execute it; the agent still needs `toolgroup:navigate` (Skill tool) and any tool-level permissions the skill requires.
- Plugins are NOT scoped per-agent today (see `runtime-sync` for the proposed scope model).

## Acceptance Criteria

- A new plugin MUST become discoverable by the runtime without code changes once placed at `~/ravi/plugins/<name>/` with a valid manifest.
- A skill inside a plugin MUST be auto-invocable by Claude Code's Skill tool given a matching prompt and the agent has `toolgroup:navigate`.
- Removing a plugin from `~/ravi/plugins/` MUST cause its skills to disappear from the next session's discovery without leaking residue into agent contexts.
