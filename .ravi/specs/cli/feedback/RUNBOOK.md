# Feedback agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/feedback --mode rules --json`.
2. Reproduce with `--json` and branch on the code: `WRITE_REQUIRES_EXECUTE`
   is the brake, `PAYLOAD_INVALID` is your payload, `AUTH_*` is login state,
   `SERVER_UNAVAILABLE` is the Console.
3. Exit `3`: read `error.plan` — it is the exact normalized payload
   (`kind`, `severity`, `title`, `message`, `surface`, `project`, `url`,
   `tags`, `metadata`, `console`) that `--execute` would submit. Review it,
   then re-run the same command adding `--execute`.
4. `PAYLOAD_INVALID` (exit 2): fix the flag it names — kind must be
   bug|idea|ux|docs|performance|security|other, severity
   low|medium|high|critical, `--metadata-json` a JSON object, message
   non-empty. These fire even in dry-run, by design.
5. `AUTH_REQUIRED`/`AUTH_EXPIRED` (exit 1): run `ravi login` (or
   `ravi login --console <url>` when targeting a non-default Console). A
   dry-run never needs this — if a dry-run asks for auth, the brake moved
   after credential reading and regressed.
6. If a send reached the Console without `--execute`, the brake regressed:
   check that `send` calls `contractDryRun` before `submitFeedback` and that
   `runFeedbackCommand` still rethrows `ContractError` instead of wrapping it.

## Validation

```bash
bun test src/cli/commands/feedback.test.ts
```

Live checks (dry-run is network-free; `--execute` requires `ravi login`):

```bash
ravi feedback send "teste de contrato" --kind idea --json      # expect exit 3 + plan
ravi feedback send "teste" --kind bogus --json                 # expect PAYLOAD_INVALID, exit 2
ravi feedback send "feedback real" --kind idea --execute --json  # expect success:true + url
```
