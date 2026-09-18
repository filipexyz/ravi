# Skill-Gated Tool Invocation Checks

## Automated Checks

```bash
bun test src/runtime/skill-gate.test.ts src/runtime/skill-visibility.test.ts
bun test src/cli/commands/skill-gates.test.ts
```

## Contract Assertions

- A tool declared with skill `foo` MUST fail the first call with
  `RAVI_SKILL_REQUIRED`, deliver the skill content, mark the skill loaded, and
  allow the second call once the skill is in the vector.
- `loadedSkillMatchesGate("pages", "ravi-system-pages")` MUST return `true`,
  and the reverse order MUST return `true` as well.
- `loadedSkillMatchesGate` MUST accept the managed aliases `ravi-system-*`,
  `ravi-dev-*` and `ravi-user-skills-*` for the same canonical name and MUST
  return `false` for distinct skills such as `tasks` vs
  `ravi-system-tasks-eval` or `image` vs `ravi-system-pages`.
- `logicalSkillKey` MUST reduce `pages`, `ravi-system-pages`,
  `ravi-dev-pages` and `ravi-user-skills-pages` to the same key and MUST leave
  unmanaged names such as `acme-pages` untouched.
- `skillIdentifiersMatch` MUST NOT read the filesystem or the plugin catalog;
  the allow path of `evaluateSkillGate` MUST stay a pure string comparison.
- On the denial path, once the gate skill is resolved, the gate MUST also
  accept the physical aliases of the resolved skill (`<plugin>-<name>` and
  `<plugin>-<dirname>`) so unmanaged plugins get the same retry behavior.
- After a denial for `ravi-system-pages` followed by `ravi skills show pages`,
  the retry MUST be allowed and `loadedSkills` MUST hold exactly one marker
  for that logical skill.
- `markLoadedFromSkillGate` MUST mark the record the session already holds for
  the logical skill (for example the advertised `pages` record) instead of
  appending a second record under the gate alias; when no record exists it
  MUST append one under the gate skill id.
- `markLoadedFromSkillGate` MUST prefer an exact id match over an alias match
  when both are present in the snapshot.
- A gate whose skill is not visible to the agent or is provided by no plugin
  MUST fail with `RAVI_SKILL_GATE_CONFIG_ERROR`, MUST NOT mark anything as
  loaded, and MUST emit a `skill.gate.error` event.
- Every `RAVI_SKILL_REQUIRED` denial MUST emit a `skill.gate.loaded` event on
  `ravi.session.<session>.runtime` carrying `toolName`, `skill`, `source`,
  `code` and `reason`.
- `ravi skills show ...` MUST stay exempt from fixed Ravi CLI gates so the
  soft gate can deliver skill content without recursion.
- A tool with no explicit or inferred gate declaration MUST run unchanged.

## Manual Smoke

1. Pick a session whose agent is granted `ravi-system-pages` and confirm the
   vector is empty with `ravi sessions visibility <session> --json`.
2. Call a `pages` tool; the response MUST be `RAVI_SKILL_REQUIRED` with the
   skill content, and `ravi events replay --type skill.gate.loaded --session
   <session>` MUST show one event.
3. Run `ravi skills show pages` from that session, then call the same tool
   again; the call MUST succeed and `loadedSkills` MUST list `pages` once.
4. Repeat step 2 against a tool gated on a skill the agent is not granted; the
   response MUST be `RAVI_SKILL_GATE_CONFIG_ERROR` and the vector MUST stay
   unchanged.
