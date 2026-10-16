# Library skills on the local runtime / RUNBOOK

## Debug Flow

1. Read the rules:
   `ravi specs get skills/library --mode rules --json`.
2. Check the login and the org the CLI talks to: `ravi whoami --json`. Without a
   login, `ravi skills search` reports `library.status: "skipped"`.
3. Reproduce with the full ref: `ravi skills show org/<slug> --json` (or
   `<project>/<slug>`). A bare slug inside an agent runtime is refused by
   design; agents use the `next` command search returns.
4. For `SKILL_NOT_AUTHORIZED`, run `ravi skills inspect <agent> --json` and
   compare `libraryGrants` and the agent's `use:skill:*` capabilities with the
   ref's id (`org:<slug>`, `project:<projectSlug>:<slug>`).
5. For `LIBRARY_SKILL_OUT_OF_VIEW`, compare the item's project with the agent's
   Console project; only an exact grant crosses projects.
6. For `LIBRARY_SKILL_EXTERNAL_DENIED`, confirm the turn is not the operator's
   own and the item has `externalAllowed: false`.
7. For `stale: true`, the Console was unreachable and the answer came from the
   cache under `<stateDir>/library/<orgId>/`.

## Validation

```bash
bun test src/library src/cli/commands/skills-library.test.ts src/cli/commands/skills.test.ts src/runtime/allowed-skills.test.ts
```
