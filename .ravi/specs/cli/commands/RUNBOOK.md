# Ravi Commands agent-first CLI contract / RUNBOOK

## Diagnose a Call

1. Read the rules with `ravi specs get cli/commands --mode rules --json`.
2. Reproduce the call with `--json` and inspect `error.code` before the text.
3. For exit 2 plus `INVALID_COMMAND_NAME`, use a non-empty name matching
   `[A-Za-z0-9][A-Za-z0-9-]{0,63}`. No registry lookup occurred.
4. For exit 2 plus pagination `USAGE_ERROR`, use `limit` from 1 through 500
   and `offset` of zero or greater; both must be integers.
5. For exit 2 plus fields `USAGE_ERROR`, read `error.acceptedFields` and retry
   using only that set. One unknown field invalidates the whole request.
6. For exit 1 plus `COMMAND_NOT_FOUND`, inspect `error.suggestions`; they are
   real ids from the same registry used by lookup.
7. For exit 1 plus `AGENT_NOT_FOUND`, inspect the suggested local agent ids.
8. Exit 1 from `commands validate` without an envelope is the preserved
   verdict that command files contain errors.
9. COMMANDS has no valid exit-3 path. `run` only renders.
10. Bare `ravi commands` is successful discovery help and must exit 0.

## Read-Only Checks

```bash
ravi commands
ravi commands show nope --json
ravi commands show "" --json
ravi commands list --agent ghost --json
ravi commands list --fields id,scope --json
ravi commands list --fields id,unknown --json
ravi commands list --limit 0 --json
ravi commands run restart --json -- "motivo"
```

Expected results, in order:

- group help, exit 0;
- `COMMAND_NOT_FOUND`, exit 1, with suggestions;
- `INVALID_COMMAND_NAME`, exit 2;
- `AGENT_NOT_FOUND`, exit 1, with suggestions;
- compact and equal `items`/`commands` rows;
- `USAGE_ERROR`, exit 2, with `acceptedFields`;
- `USAGE_ERROR`, exit 2;
- a rendered prompt preview with no session publication.

For a zero-write check, hash the configured agent and global command
directories before and after every call. Repeating unchanged calls must retain
values, ordering, `pagination.nextCommand`, and
`metadata.renderedPromptSha256`. In an isolated test process, set
`RAVI_SUPPRESS_AUDIT_EVENTS=1` so transport evidence does not alter the state
being inspected; suppression does not change command semantics.

## Repository Validation

```bash
bun test src/cli/commands/commands.test.ts
bun test src/commands/index.test.ts
bun run sdk:generate
bun run sdk:check
bun run typecheck
bun run build
bun src/ci/run-quality-gate.ts
bun run lint:docs
```

Do not use a benchmark or external test bench for this domain increment. Its
evidence belongs in native operation tests and normal repository gates.
