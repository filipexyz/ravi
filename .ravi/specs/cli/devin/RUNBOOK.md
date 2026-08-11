# Devin agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/devin --mode rules --json`.
2. Reproduce the failing call with `--json` and read `error.code` first.
3. Exit `1` + `DEVIN_SESSION_NOT_FOUND`: read `error.suggestions` (local
   cache); refresh with `ravi devin sessions list --remote --json` if the
   session was created outside this machine.
4. Exit `3`: read `error.plan` (prompt/message length, maxAcuLimit, secret COUNT),
   confirm the spend is intended, then re-run adding `--execute`.
5. Dry-run failing with a config error: the brake regressed — it must fire
   BEFORE `createDevinClientFromEnv`, so inspection works without DEVIN_* env.
6. Runaway/billing session: `ravi devin sessions terminate <id>` immediately —
   terminate is unbraked precisely for this (add `--archive` to tidy up).
7. Secrets appearing in a plan: hard contract violation — the plan carries
   only `sessionSecretCount`; fix before anything else.

## Validation

```bash
bun test src/cli/commands/devin.test.ts
```

Live checks (dry-run needs no credentials; `--execute` spends real ACUs — do
not run it for validation):

```bash
ravi devin sessions create --prompt "x" --max-acu 5 --json   # expect exit 3 + plan
ravi devin sessions send sess-nope "x" --json                # expect exit 1 + suggestions
ravi devin sessions list --fields devinId,status --json      # expect compact items
```
