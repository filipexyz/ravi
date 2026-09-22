# Global bug-report agent-first CLI contract / CHECKS

## Checks

- `bug report` without `--execute` MUST exit 3, MUST report `dryRun: true`
  with a content-minimized plan plus the `ravi.bug_report/v1` collection
  prompt, and MUST NOT read credentials nor perform any network call.
- `bug report --dossier-json '<valid>' --execute` MUST POST to
  `/api/cli/bugs` with Console `createBodySchema` (`title`, `summary`,
  `severity`, required `payload` holding the full dossier + `source`).
  Slug org/project refs MUST stay inside `payload.context` and MUST NOT
  appear as top-level `organizationId` / `projectId`. Then print the bug
  id and tracking URL. Then it MUST `POST /api/cli/bugs/<id>/subscribe`
  with `{ installationId }` and ensure a trigger on
  `ravi.watch.console.bug.status` whose filter matches only that bugId
  (`data.payload.bugId == "<id>" || data.bugId == "<id>"`) and fires
  into the current/`main` session (cooldown 30s). Follow failure MUST
  warn and MUST NOT fail the create.
- The dry-run plan MUST omit raw title, summary, evidence, organization /
  project refs, session hints, and Console override. `surface` MAY remain.
- Invalid `--severity`, broken `--dossier-json` / `--dossier-file`,
  conflicting dossier sources, or `--execute` without a complete dossier
  MUST exit 2 with `PAYLOAD_INVALID` even without `--execute` when the
  supplied input is already unsendable.
- The `ContractError` thrown by the brake MUST NOT be wrapped by
  `cloudAuthErrorFromUnknown` — exit 3 must survive `runBugCommand`.
- Missing credentials on `--execute`, `status`, `list`, or `comment`
  MUST keep the `AUTH_REQUIRED` guidance (`ravi login`). A dry-run MUST
  NOT require credentials at all.
- The alias `bug create` MUST behave identically to `bug report`, including
  the brake.
- `bug list` MUST expose `--json`, `--limit`, `--offset`, and `--fields`.
- `bug status <id>` MUST GET `/api/cli/bugs/<id>`.
- `bug comment <id>` without `--execute` MUST exit 3, MUST report
  `dryRun: true` with a content-minimized plan plus the
  `ravi.bug_comment/v1` collection prompt, and MUST NOT read credentials
  nor perform any network call. Raw `--text` MUST NOT appear in the plan.
- `bug comment <id> --text '<sanitized>' --execute` MUST POST to
  `/api/cli/bugs/<id>/comments` with Console `commentBodySchema`
  (`schemaVersion`, optional `text`, required `payload` + `source`,
  `idempotencyKey`). Tokens and secret assignments in `--text` or
  `--evidence-file` MUST be redacted before the body leaves the machine.
- The same sanitized payload MUST produce the same default
  `idempotencyKey` (`sha256:<hex>`). An explicit `--idempotency-key`
  overrides it. Idempotency is server-side: Console MUST replay the
  original comment (`reused: true`) instead of inserting a duplicate.
- `--execute` without text or evidence, a broken comment dossier, or a
  `ravi.bug_report/v1` create dossier passed as the comment MUST exit 2
  with `PAYLOAD_INVALID` even without `--execute` when the supplied
  input is already unsendable.
- The default system prompt MUST tell the agent to ask the user before
  filing and to use `ravi bug report` (not `ravi feedback`) after a yes.
  It MUST also tell the agent to append follow-up evidence with
  `ravi bug comment <id>` on the same id instead of filing a second report.
- `bun test src/cli/commands/bug.test.ts` SHOULD pass after any change to
  the bug-report contract surface.
- `bun test src/bug-report/client.test.ts` SHOULD pass for create and
  comment body mapping plus stable idempotency keys.
- `bun test src/bug-report/sanitize.test.ts` SHOULD prove tokens and
  secret assignments are redacted.
- `bun test src/bug-report/follow.test.ts` SHOULD prove the filter is
  scoped to the created bugId and rejects other ids.
- `bun test src/prompt-builder.test.ts` SHOULD still include the bug-report
  session paragraph and the `ravi bug comment <id>` follow-up rule.
