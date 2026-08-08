# Mail agent-first CLI contract / CHECKS

## Checks

- Every braked mail/Gmail send without `--execute` MUST exit 3 and report an
  exact metadata-only plan with `fromPresent`, `toCount`, `ccCount`,
  `bccCount`, `subjectChars`, `bodyChars` and `inReplyToPresent`; raw
  addresses, subject, body, connector id and message id MUST be absent.
- `mail send` without `--execute` MUST NOT create any local message or outbox
  row; `mail reply` MUST NOT enqueue anything.
- `mail providers ravi-mail send` without `--execute` MUST exit 3 and MUST NOT
  issue any Console API request.
- `gmail send` without `--execute` MUST exit 3 BEFORE any connector call —
  neither `listConnectors` nor `execCapability` may run on a dry-run.
- Each braked send with `--execute` MUST perform the real write: local outbox
  row for `mail send`/`mail reply`, provider request for
  `mail providers ravi-mail send` and `gmail send`.
- An unknown account on `mail accounts sync --json` MUST exit 1 with
  `ACCOUNT_NOT_FOUND` and up to three `suggestions` of real account ids/names.
- An unknown mailbox ref on show/disable/list filters and send/reply `--from`
  MUST exit 1 with `MAILBOX_NOT_FOUND` and up to three `suggestions` of real
  addresses/ids.
- An unknown message, outbox row, or thread id MUST exit 1 with
  `MESSAGE_NOT_FOUND`/`OUTBOX_NOT_FOUND`/`THREAD_NOT_FOUND`, omitting
  `suggestions` and carrying a `suggestedAction` that points at the listing
  command — including the `readMailMessage` throw path used by
  `mail messages read` and `mail reply`.
- The local listings (`accounts list`, `mailboxes list`, `messages list`,
  `outbox list`, `providers list`) with `--fields a,b,c --json` MUST return
  items containing only the requested fields.
- A `ContractError` thrown inside `runMailCommand`/`runGmailCommand` MUST be
  rethrown untouched — never wrapped into the CloudAuthError funnel — so agent
  callers keep the 1/2/3 exit taxonomy.
- Unbraked writes listed in the spec (creates, sync, import, retry, disable)
  MUST keep immediate-write behavior.
- The suite `bun test src/cli/commands/mail.test.ts` SHOULD pass after any
  change to the mail contract surface.
