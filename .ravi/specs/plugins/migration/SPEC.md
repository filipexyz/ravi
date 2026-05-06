---
id: plugins/migration
title: "Plugin Migration"
kind: capability
domain: plugins
capability: migration
tags:
  - plugins
  - migration
  - skills
  - agents
applies_to:
  - agents/*/AGENTS.md
  - agents/*/.claude/skills
  - src/plugins/internal
  - src/skills/manager.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Plugin Migration

## Intent

This capability defines the contract operators follow when moving capability content out of an agent's `AGENTS.md` (or out of an agent-local `.claude/skills/`) into a plugin. Migration is one-skill-at-a-time, reversible, and validated by an end-to-end discovery test before being declared done.

The capability exists because the practical introduction of plugins happens against a base of ~100+ skills that already live inside agents. There MUST be a deterministic path from "skill inlined in AGENTS.md" to "skill in plugin, agent file references it" that does not rely on operator memory.

## Categorization Before Migration

Each candidate skill MUST be classified before being migrated:

- **A — Single-agent skill.** The skill is meaningful to exactly one agent (e.g. an agent-specific pipeline). Target: solo plugin `ravi-<domain>`.
- **B — Multi-agent skill.** The skill is reused across two or more agents (e.g. shared communication patterns). Target: shared plugin (`ravi-user-skills` or a domain plugin).
- **C — Experimental / personal.** The skill is iterating, scoped to one operator, and has no near-term need for distribution. Target: stay in `~/.claude/skills/` or agent-local `.claude/skills/`. Do not migrate.
- **D — External catalog.** The "skill" is documentation or reference material from another project (e.g. SDE standalone catalogs). Do not migrate; lifecycle belongs to that project.

## Rules

- A migration MUST process exactly one skill per execution. Batch migrations across multiple skills MUST NOT happen without explicit per-skill approval.
- A migration MUST take a backup of the original skill content before any move. Convention: `<original>.bak.<unix-timestamp>`.
- After moving the skill into the plugin, the runtime MUST re-discover (`ravi skills sync` or session restart) and the operator MUST validate via `ravi skills list --installed` that the skill is recognized.
- The agent's `AGENTS.md` MUST be reduced after migration: any content duplicated with `SKILL.md` MUST be removed; the agent file MUST retain only identity, fluxo de entrada (when to load the skill), anti-loop, cross-agent delegation, and rules that genuinely belong to the agent (not the skill).
- A migration is NOT done until a live discovery test has passed: at least three real prompts the agent receives in practice MUST cause the skill to be auto-invoked via the Skill tool. If discovery fails, the migration MUST be rolled back and the skill `description` revisited (the description is the discovery contract).
- A rollback MUST restore from the timestamped backup and remove the plugin destination directory. Rollback MUST be a single deterministic procedure documented alongside the migration.

## Steps (canonical order)

1. **Classify** the skill (A / B / C / D). Stop here for C and D.
2. **Prepare destination** — create the plugin directory and `.claude-plugin/plugin.json` for category A; reuse the existing plugin for category B.
3. **Backup and move** — copy original to `<original>.bak.<timestamp>`; move (not copy) the skill directory into `<plugin>/skills/<skill-name>/`.
4. **Validate discovery** — run `ravi skills sync` and `ravi skills list --installed`. Inspect with `ravi skills show <skill> --installed`.
5. **Reduce `AGENTS.md`** — remove duplicated CLI lists, duplicated rules, duplicated examples. Keep agent identity, fluxo, anti-loop, cross-agent delegation, agent-only rules.
6. **Discovery test** — three real prompts, three auto-invocations confirmed in logs.
7. **Permission check** — confirm the agent has `toolgroup:navigate` (Skill tool); grant if missing.
8. **Final validation** — backup retained, AGENTS.md visibly shorter, discovery test green, agent runs a real task end-to-end.

## Out of Scope

- Migration does not change skill semantics. If the skill needs to be improved, that is a separate change with its own review.
- Migration does not introduce new permissions. If the skill needs new tool permissions, those MUST be granted as a distinct, audited action.
- Migration does not move skills out of `~/ravi-sde/claude-code-skills/skills-catalog/` (category D). Those are external project assets.

## Acceptance Criteria

- After migration, the agent's `AGENTS.md` line count is measurably smaller (record before/after as part of the migration record).
- After migration, the skill is auto-invocable for at least three production-realistic prompts.
- Backup of the original location exists and is retrievable for at least one full operational cycle (target: 30 days) before being archived.
- A failed migration leaves the system in the pre-migration state via rollback. The rollback procedure is exercised at least once before declaring this capability operational.
