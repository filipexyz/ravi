# CRM agent-first CLI contract / CHECKS

## Checks

- Every `--json` failure on a contract op MUST return the envelope
  `{success:false, op, error:{code, message, retryable, suggestedAction}}`;
  plain text and stack traces MUST NOT reach the caller.
- A not-found entity MUST exit 1 and MUST carry up to three `suggestions` of
  similar real entities.
- An invalid flag or argument value MUST exit 2 with `acceptedFlags` listing the
  flags the op accepts.
- A write op invoked without `--execute` MUST exit 3, MUST report `dryRun: true`
  with the `plan` it would apply, and MUST NOT write.
- Exit 3 MUST NOT be treated as a failure of the command; it is the write brake
  reporting that the caller has to confirm.
- `opportunity create` MUST stay guarded while the domain offers no delete or
  archive path for opportunities.
- Listings MUST accept `--fields a,b,c` and MUST return `pagination.nextCommand`
  as a literal command or `null`.
- Per-op help MUST stay under 20KB so discovery does not flood an agent context.
- The shipped `crm` skill MUST document `--execute` wherever it shows a braked
  write; a skill teaching an unbraked write fails this spec.
- `bun test src/cli/commands/crm.test.ts src/apps/router.test.ts` SHOULD pass
  after any change to the CRM contract or the per-op help router.
