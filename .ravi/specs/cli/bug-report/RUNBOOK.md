# Global bug-report agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/bug-report --mode rules --json`.
2. Reproduce with `--json` and branch on the code: `WRITE_REQUIRES_EXECUTE`
   is the brake, `PAYLOAD_INVALID` is the dossier, `AUTH_*` is login state,
   `SERVER_UNAVAILABLE` is the Console (or the sibling Console PR has not
   landed `POST /api/cli/bugs` yet).
3. Exit `3`: read `error.plan` and the printed collection prompt. Fill
   schema `ravi.bug_report/v1`, sanitize, confirm with the user, then
   re-run adding `--execute`.
4. `PAYLOAD_INVALID` (exit 2): fix the field it names — severity must be
   low|medium|high|critical, dossier JSON must be an object with title,
   summary, and severity, and `--dossier-json` / `--dossier-file` must not
   be combined. These fire even in dry-run when the supplied input is
   already unsendable.
5. `AUTH_REQUIRED` / `AUTH_EXPIRED` (exit 1): run `ravi login` (or
   `ravi login --console <url>`). A dry-run never needs this — if a dry-run
   asks for auth, the brake moved after credential reading and regressed.
6. If a report reached Console without `--execute`, the brake regressed:
   check that `report` calls `contractDryRun` before `submitBugReport` and
   that `runBugCommand` still rethrows `ContractError`.
7. Do not "fix" a missing Console route by posting to `/api/cli/feedback`.
   Keep `/api/cli/bugs` stable and wait for the sibling Console PR.

## Validation

```bash
bun test src/cli/commands/bug.test.ts
bun test src/prompt-builder.test.ts
```

Live checks (dry-run is network-free; `--execute` / `status` / `list`
require `ravi login` and a Console that implements `/api/cli/bugs`):

```bash
ravi bug report --json                                 # expect exit 3 + plan + collection prompt
ravi bug report --severity bogus --json                # expect PAYLOAD_INVALID, exit 2
ravi bug report --dossier-json '{"schemaVersion":"ravi.bug_report/v1","title":"x","summary":"y","severity":"low"}' --execute --json
ravi bug status <id> --json
ravi bug list --json --limit 20
```
