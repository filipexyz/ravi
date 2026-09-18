# Skill-Gated Tool Invocation Runbook

## Find Out Which Skill A Tool Requires

```bash
ravi tools show <tool>
ravi skill-gates list --json
ravi skill-gates show <rule-id> --json
```

`ravi tools show` prints `Skill Gate: <skill> (<source>)` when the tool is
gated. `source` tells whether the gate came from a decorator, registry
inference, or a configured operator rule.

## Read A Gate Denial

A gated call fails with one of two codes:

- `RAVI_SKILL_REQUIRED` — the skill exists and is authorized but was not in
  the session's `loadedSkills` vector. The payload carries the skill content
  and the runtime has already marked the skill as loaded. The retry is
  expected to pass.
- `RAVI_SKILL_GATE_CONFIG_ERROR` — no runtime session is bound to the
  context, the skill is not visible to the agent, or no installed or catalog
  skill provides it. This is a configuration problem; retrying without
  changing config will not help.

Every denial also emits a `skill.gate.loaded` or `skill.gate.error` event on
`ravi.session.<session>.runtime`:

```bash
ravi events replay --type skill.gate.loaded --session <session> --since 1h
ravi events replay --type skill.gate.error --session <session> --since 1h
```

## Debug A Gate That Denies Forever

Symptom: every retry of the same tool returns `RAVI_SKILL_REQUIRED` even
though the agent loaded the skill.

1. Inspect the session's visibility snapshot:

```bash
ravi sessions visibility <session> --json
```

2. Compare `loadedSkills` with the skill named in the denial. The vector
   normally records the plugin short id (`pages`) while the gate rule names the
   catalog alias (`ravi-system-pages`). Those two MUST be treated as the same
   logical skill; if the vector holds `pages` and the gate still denies
   `ravi-system-pages`, the equivalence in
   `loadedSkillMatchesGate` / `skillIdentifiersMatch` regressed.
3. Confirm the skill really is the same one. Managed prefixes
   (`ravi-system-`, `ravi-dev-`, `ravi-user-skills-`) are stripped for the
   comparison, but `tasks` does not satisfy `ravi-system-tasks-eval` and
   `image` does not satisfy `ravi-system-pages`. A rule that names a different
   skill is a rule bug, not a matching bug.
4. For a skill from an unmanaged plugin (for example `acme-pages`), the gate
   accepts the physical aliases of the resolved skill only after it resolved
   the skill on the denial path. Check the plugin name and skill directory
   name with `ravi skills show <skill> --json`.
5. Check `skills[]` in the visibility payload for two records naming the same
   logical skill (one `advertised`, one `loaded`). The gate MUST update the
   existing record, so a duplicate points at `markLoadedFromSkillGate`.
6. If `loadedSkills` is empty right after a compact or reset, the vector was
   legitimately cleared; the next denial delivers the skill again and that
   retry MUST pass. Cross-turn persistence of the marker is owned by
   `runtime/session-visibility`, not by the gate.

## Debug A Configuration Error

1. Confirm the skill is visible to the agent:

```bash
ravi skills inspect <agent> --json
```

2. If the skill is missing from the agent's catalog, grant it through
   `ravi skills grant` or a group permission. The gate MUST NOT auto-load a
   skill the agent is not allowed to read.
3. If no plugin provides the skill at all, fix the gate declaration (`tool`,
   `command`, `commandPrefix`, or `commandRegex` plus `skill`) rather than the
   session.

## Reproduce The Retry Locally

```bash
bun test src/runtime/skill-gate.test.ts -t "loaded-marker equivalence"
```

The suite drives a real session through denial, `ravi skills show <short-id>`,
and retry, and asserts the retry is allowed with a single `pages` marker.

## Change Procedure

1. Keep gate evaluation a pure string comparison on the allow path; only the
   denial path may resolve the skill.
2. Change `loadedSkillMatchesGate`, `skillIdentifiersMatch`,
   `logicalSkillKey`, and `markLoadedFromSkillGate` together so matching and
   marking agree on what "the same skill" means.
3. Add a test for each new alias shape in `src/runtime/skill-gate.test.ts` and
   `src/runtime/skill-visibility.test.ts`.
4. Run the checks in `CHECKS.md` and then the repository quality gate.
