# CRM agent-first CLI contract / CHECKS

## Checks

- Every `--json` failure on a contract op MUST return the envelope
  `{success:false, op, error:{code, message, retryable, suggestedAction}}`;
  plain text and stack traces MUST NOT reach the caller.
- A not-found entity MUST exit 1 and MUST carry up to three `suggestions` of
  similar real entities.
- A pipeline review with high-severity gaps and invalid pipeline metadata MUST
  fail canonically in text and JSON with exit 1; review details MUST contain
  only field names, classifications, suggestions, and aggregate counts.
- An invalid flag or argument value MUST exit 2 with `acceptedFlags` listing the
  flags the op accepts.
- `pipeline create`, `opportunity create`, and `opportunity move` MUST execute
  immediately without `--execute`, return exit 0, and remain `kind: "mutate"`.
- Invalid CRM input MUST still fail before any local persistence.
- Migrated listings MUST accept `--fields a,b,c` and MUST return
  `pagination.nextCommand` as a literal command or `null`.
- Per-op help MUST stay a compact screenful so discovery does not flood an
  agent context.
- The shipped `crm` skill MUST teach these local writes without `--execute`.
- `bun test src/cli/commands/crm.test.ts src/apps/router.test.ts` SHOULD pass
  after any change to the CRM contract or the per-op help router.
