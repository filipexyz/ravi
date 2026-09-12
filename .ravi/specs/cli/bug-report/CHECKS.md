# Global bug-report agent-first CLI contract / CHECKS

## Checks

- `bug report` without `--execute` MUST exit 3, MUST report `dryRun: true`
  with a content-minimized plan plus the `ravi.bug_report/v1` collection
  prompt, and MUST NOT read credentials nor perform any network call.
- `bug report --dossier-json '<valid>' --execute` MUST POST to
  `/api/cli/bugs` with the normalized dossier and `source: "cli"`, then
  print the bug id and tracking URL.
- The dry-run plan MUST omit raw title, summary, evidence, organization /
  project refs, session hints, and Console override. `surface` MAY remain.
- Invalid `--severity`, broken `--dossier-json` / `--dossier-file`,
  conflicting dossier sources, or `--execute` without a complete dossier
  MUST exit 2 with `PAYLOAD_INVALID` even without `--execute` when the
  supplied input is already unsendable.
- The `ContractError` thrown by the brake MUST NOT be wrapped by
  `cloudAuthErrorFromUnknown` — exit 3 must survive `runBugCommand`.
- Missing credentials on `--execute`, `status`, or `list` MUST keep the
  `AUTH_REQUIRED` guidance (`ravi login`). A dry-run MUST NOT require
  credentials at all.
- The alias `bug create` MUST behave identically to `bug report`, including
  the brake.
- `bug list` MUST expose `--json`, `--limit`, `--offset`, and `--fields`.
- `bug status <id>` MUST GET `/api/cli/bugs/<id>`.
- The default system prompt MUST tell the agent to ask the user before
  filing and to use `ravi bug report` (not `ravi feedback`) after a yes.
- `bun test src/cli/commands/bug.test.ts` SHOULD pass after any change to
  the bug-report contract surface.
- `bun test src/prompt-builder.test.ts` SHOULD still include the bug-report
  session paragraph.
