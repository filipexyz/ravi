# Runtime credentials agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/runtime-credentials --mode rules --json`.
2. Reproduce the failing call with `--json` and read `error.code` first.
3. Exit `1` + `CREDENTIAL_NOT_FOUND`: read `error.suggestions` — live
   credential ids and labels similar to what was asked. Retry with one of
   them, or list with `ravi runtime credentials list --all --json`.
4. If an envelope ever contains a secret env var name, a secret value or an
   unredacted auth-profile path, that is a security regression against
   invariant 4 of the SPEC — fix before anything else ships.
5. Health confusion (credential exists but is skipped by selection): use
   `ravi runtime credentials status <id> --json` and
   `ravi runtime credentials select --provider <id> --json` to see the
   rejection reasons; `reset-health` or `refresh` recover state without
   destroying anything.

## Validation

```bash
bun test src/cli/commands/runtime-credentials.test.ts
```

Live checks against the local CLI (read-only; use an isolated
`RAVI_STATE_DIR`):

```bash
ravi runtime credentials status rc-nope --json         # expect exit 1 + id/label suggestions
ravi runtime credentials list --fields id,label --json # expect compact items
ravi runtime credentials select --provider claude --json  # expect selection preview
```
