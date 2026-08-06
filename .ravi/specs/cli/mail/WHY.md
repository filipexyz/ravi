# Mail agent-first CLI contract / WHY

Mail is the one CLI domain where a wrong write leaves the machine: `mail send`,
`mail reply`, `mail providers ravi-mail send` and `gmail send` all end as an
e-mail in a real human's inbox, with no undo. That is why every send path got
the write brake while the rest of the domain — account/mailbox/domain creation,
sync, import, retry, disable — stayed immediate: those are local projections or
re-runnable ingestion with a reverse path, and braking them would add exit-3
friction to setup and recovery loops that never touch an external recipient.
`outbox retry` deliberately stays unbraked: the brake belongs at enqueue time
(`send`/`reply`), and retry only re-queues a payload that already passed it.

Decisions that shaped this wave:

- Suggestions only where the source is a cheap local list with human-guessable
  identifiers: accounts (ids/names) and mailboxes (addresses/ids). Messages,
  outbox rows and threads have opaque ULIDs — Dice-bigram suggestions on those
  are noise, so their envelopes carry a `suggestedAction` pointing at the
  listing command instead.
- The mail domain has its own legacy error funnel (`runMailCommand` /
  `runGmailCommand` → CloudAuthError → `formatCloudAuthError`), the same
  swallow-everything shape the agents domain hit: both funnels now rethrow
  `ContractError` first, otherwise the brake exits as a generic provider error.
- `gmail send` brakes BEFORE `resolveDefaultGoogleConnector`: the plan can name
  the connector as "(default google connector)", but a dry-run must not run the
  connector lookup — that is a provider/DB call.
- Dry-run plans show `bodyPreview` (first 120 chars, whitespace-collapsed)
  instead of the full body, matching the domain's existing redaction posture
  (outbox payloads print `[redacted]`).
- The parser-level usage contract uses the shared exit-2 `USAGE_ERROR`
  envelope for both `mail` and `gmail`.

Test-infrastructure finding that benefits every domain: on Windows,
`cleanupIsolatedRaviState` failed with EBUSY because Bun keeps memory-mapped
SQLite WAL/SHM handles alive until the closed wrappers are garbage collected —
all DB-touching mail tests failed at baseline on win32. The cleanup now forces
`Bun.gc(true)` and retries the removal, deferring still-locked dirs to the
process-exit sweep.
