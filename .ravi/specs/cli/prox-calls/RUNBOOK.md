# Prox Calls agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/prox-calls --mode rules --json`.
2. Reproduce the failing call with `--json` and read `error.code` first.
3. Exit `1` + `*_NOT_FOUND`: read `error.suggestions` (profiles, voice agents,
   tools come from the local DB). For `CALL_REQUEST_NOT_FOUND` there is no
   list op — recover the `cr_*` id from the original `request` output or the
   originating session.
4. Exit `3`: read `error.plan` (profile/provider, target/input presence,
   providerMode), confirm the CALL is intended with the operator, then re-run
   adding `--execute`.
5. Call executed but should not have: `ravi prox calls cancel <id> --reason
   "..."` immediately — cancel is unbraked precisely for this.
6. `TRANSCRIPT_NOT_FOUND`: ElevenLabs profiles → retry with `--sync`; Agora →
   the transcript arrives via webhook event 103, do not poll `--sync`.
7. If a request was submitted without `--execute`, the brake regressed: check
   `contractDryRun` still runs before `submitCallRequest` and after the
   profile-existence check.

## Validation

```bash
bun test src/cli/commands/prox-calls.test.ts
```

Live checks (dry-run or stub provider only):

```bash
ravi prox calls request --profile followup --person p1 --reason teste --json   # expect exit 3 + plan
ravi prox calls show cr_nope --json                                            # expect exit 1 + CALL_REQUEST_NOT_FOUND
ravi prox calls profiles show ghost --json                                     # expect exit 1 + suggestions
ravi prox calls profiles list --fields id,name --json                          # expect compact items
```
