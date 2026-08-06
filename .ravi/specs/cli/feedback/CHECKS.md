# Feedback agent-first CLI contract / CHECKS

## Checks

- `feedback send <msg>` without `--execute` MUST exit 3, MUST report
  `dryRun: true` with a `plan` mirroring the normalized payload, and MUST NOT
  read credentials nor perform any network call.
- `feedback send <msg> --execute` MUST POST to `/api/cli/feedback` with the
  same normalized payload the plan showed and print the Console feedback URL.
- The dry-run plan MUST carry normalized values (kind/severity defaults
  applied, tags normalized) — not the raw flag inputs.
- Invalid `--kind`, `--severity`, `--metadata-json` or an empty message MUST
  exit 1 with `PAYLOAD_INVALID` even without `--execute` — payload validation
  fires in dry-run too, never as exit 3.
- The `ContractError` thrown by the brake MUST NOT be wrapped by
  `cloudAuthErrorFromUnknown` — exit 3 must survive `runFeedbackCommand`.
- Missing credentials on `--execute` MUST keep the `AUTH_REQUIRED` guidance
  (`ravi login`), and a dry-run MUST NOT require credentials at all.
- The alias `feedback create` MUST behave identically to `feedback send`,
  including the brake.
- `bun test src/cli/commands/feedback.test.ts` SHOULD pass after any change to
  the feedback contract surface.
