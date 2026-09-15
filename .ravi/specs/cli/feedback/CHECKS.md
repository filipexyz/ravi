# Feedback agent-first CLI contract / CHECKS

## Checks

- `feedback send <msg>` without `--execute` MUST exit 3, MUST report
  `dryRun: true` with `{kind, severity, titlePresent, messageChars, surface,
  projectPresent, urlPresent, tagsCount, metadataKeys}`, and MUST NOT read
  credentials nor perform any network call.
- `feedback send <msg> --execute` MUST POST to `/api/cli/feedback` with the
  full normalized payload and print the Console feedback URL.
- The dry-run plan MUST derive kind/severity defaults and tag counts from
  normalized values. `metadataKeys` MUST contain sorted key names only; raw
  title, message, project, URL, tag values, metadata values and Console
  override MUST be absent.
- Invalid `--kind`, `--severity`, `--metadata-json` or an empty message MUST
  exit 2 with `PAYLOAD_INVALID` even without `--execute` — payload validation
  fires in dry-run too, never as exit 3.
- The `ContractError` thrown by the brake MUST NOT be wrapped by
  `cloudAuthErrorFromUnknown` — exit 3 must survive `runFeedbackCommand`.
- Missing credentials on `--execute` MUST keep the `AUTH_REQUIRED` guidance
  (`ravi login`), and a dry-run MUST NOT require credentials at all.
- The alias `feedback create` MUST behave identically to `feedback send`,
  including the brake.
- `bun test src/cli/commands/feedback.test.ts` SHOULD pass after any change to
  the feedback contract surface.
