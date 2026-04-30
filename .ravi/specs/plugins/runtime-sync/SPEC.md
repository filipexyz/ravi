---
id: plugins/runtime-sync
title: "Plugin Runtime Sync"
kind: capability
domain: plugins
capability: runtime-sync
tags:
  - plugins
  - runtime
  - sync
  - drift
applies_to:
  - src/plugins/index.ts
  - src/skills/manager.ts
  - src/runtime
owners:
  - ravi-dev
status: draft
normative: true
---

# Plugin Runtime Sync

## Intent

`runtime-sync` is the proposed mechanism that lets a plugin be the durable source of truth while each agent's working directory holds an active, modifiable copy. The runtime reconciles the two on session start: copy from plugin into agent on first use, prompt the operator on drift, and reset the loaded-skills vector on compact.

The capability exists so per-agent scope, operator-editable skills, and plugin-as-source-of-truth can coexist without forcing a global discovery model.

## Model

The reconciliation runs at session start, before the first provider turn:

1. Resolve the plugins **associated with this agent**. Initial association mechanism: per-agent local plugin at `<agent-cwd>/.ravi/plugins/<plugin>/` is implicitly associated. Future: explicit association command (out of scope here).
2. For each associated plugin, for each skill inside it:
   - Compute the local destination path. Default: `<agent-cwd>/.claude/skills/<skill-name>/`. Alternate: `<agent-cwd>/.agents/skills/<skill-name>/` when the agent uses the agents-folder convention.
   - If the destination does not exist, copy the skill from the plugin into the destination.
   - If the destination exists and matches the plugin (by content hash), no action.
   - If the destination exists and **diverges from the plugin** (operator edited locally or plugin advanced), the runtime MUST surface a drift prompt to the operator: *"this skill diverged from its plugin source — replace, keep local, or diff?"*.
3. Record the resolved skill set as the session's loaded-skills baseline (see `runtime/skill-loading`).

## Rules

- The runtime MUST NOT silently overwrite a divergent local skill copy. Drift MUST raise a prompt the operator answers explicitly.
- The runtime MUST emit a structured event for each sync action (created, kept, replaced, drift-detected) so observability can trace what happened on session start.
- Drift detection MUST compare content, not timestamps. A content hash of the skill directory (excluding caches) is the canonical drift signal.
- If the operator chooses *replace*, the runtime MUST take a backup at `<destination>.bak.<timestamp>` before writing the plugin version.
- If the operator chooses *keep*, the local copy is treated as the truth for the session and the plugin version is NOT installed.
- A session that begins with no associated plugins MUST start with an empty loaded-skills vector and load skills only on demand (Skill tool invocation), preserving today's behaviour.
- The runtime sync MUST be idempotent: re-running on an unchanged state produces no events and no filesystem mutations.

## Failure Modes

- **Drift prompt unanswered** — the runtime MUST default to *keep* and proceed. It MUST NOT block session start indefinitely.
- **Plugin disappeared between starts** — the local copy remains. The runtime MUST log a warning but not delete the local skill.
- **Filesystem write fails** — the runtime MUST surface the error to the operator and proceed without that skill, not abort the session.

## Acceptance Criteria

- A plugin update at `<agent-cwd>/.ravi/plugins/<plugin>/skills/<skill>/` MUST be visible in the next session as a drift prompt unless the local copy was untouched.
- An operator edit to `<agent-cwd>/.claude/skills/<skill>/` MUST be detected as drift and offered for resolution rather than overwritten.
- The drift event log MUST be queryable via `ravi events` filtered by sync action.
