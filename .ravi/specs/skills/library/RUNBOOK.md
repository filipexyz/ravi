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
7. For `stale: true` on `search` or `show`, the Console was unreachable and the
   answer came from the cache under `<stateDir>/library/<orgId>/`.
8. For proposals, start with `ravi skills proposals <ref> --state all --json`
   and `ravi skills proposal <ref> <n> --json`: `author.self` and
   `author.agentId` say who may update it, `stale` says its base is behind the
   published version, and `can` says what this login may do.
9. For `LIBRARY_AGENT_CANNOT_PUBLISH`, the call ran in an agent runtime: the
   agent proposes (`ravi skills propose ... --execute`) and a person publishes
   in the Console.
10. For `CONFLICT`, read `error.conflict` (the envelope redacts `reason`):
    `stale_base` means read the new version and plan again (`--rebase` with
    `--update`), `unchanged` means nothing differs from the published version.

## Validation

```bash
bun test src/library src/cli/commands/skills-library.test.ts src/cli/commands/skills.test.ts src/runtime/allowed-skills.test.ts src/runtime/skill-visibility.test.ts
```
