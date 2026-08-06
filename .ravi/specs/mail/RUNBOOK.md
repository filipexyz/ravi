# Mail / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get mail --mode rules --json` (CLI contract
   details live in `cli/mail`; local mailbox behavior in `mail/local-mailbox`).
2. Inspect local state first — it is the source of truth for agents:
   `ravi mail accounts list --json`, `ravi mail mailboxes list --json`,
   `ravi mail messages list --mailbox <mailbox> --json`.
3. For a send that "did not arrive", check the local outbox before blaming the
   provider: `ravi mail outbox status` / `ravi mail outbox list --json`. A
   queued entry with retries means the provider path failed; the local write
   worked.
4. For provider sync issues, check `ravi mail providers list --json` and the
   provider-specific status (`ravi mail providers ravi-mail status`), then look
   for `ravi.mail.provider.sync.failed` events.
5. For a message that exists remotely but not locally, run the account sync
   (`ravi mail accounts sync <account>`) and verify duplicate provider events
   did not create duplicate local messages (import is idempotent).
6. For identity questions (who is this address?), resolve through the contacts
   identity graph — a raw address is provenance, never a canonical contact.

## Validation

```bash
bun test src/cli/commands/mail.test.ts
```

Local checks (isolated `RAVI_STATE_DIR`, no provider needed):

```bash
ravi mail accounts list --json
ravi mail messages list --mailbox <mailbox> --json
ravi mail send --from <mailbox> --to a@b.c --subject t --body b --json   # exit 3 dry-run
ravi mail outbox status
```
