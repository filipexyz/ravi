# CRM CLI interface / RUNBOOK

## Debug Flow

1. Read `ravi specs get cli/crm --mode rules --json`, then the inherited `cli`
   rules.
2. Reproduce with `--json` and branch on `error.code`, not the message.
3. For not-found, inspect visibility-filtered `suggestions`.
4. For usage errors, inspect `acceptedFlags` and `acceptedPositionals` before
   opening broader help.
5. Compare focused `--help` with `ravi crm help --json`; both MUST describe the
   same live arguments.
6. If the issue concerns effect state, approval, execution, verification, or
   recovery, switch to `crm/facade`.

## Validation

```bash
bun test src/cli/commands/crm.test.ts src/apps/router.test.ts
```

Use an isolated `RAVI_STATE_DIR` for live interface checks:

```bash
ravi crm pipeline show unknown-id --json
ravi crm board --no-such-flag --json
ravi crm pipeline list --fields id,name --json
ravi crm pipeline show --help
ravi crm help --json
```

These checks cover interface and discovery only. Use the owning CRM child spec
for effect behavior.
