# Mail / CHECKS

## Checks

- Local reads (list, read, search over synced data) MUST keep working when the
  remote provider is unavailable.
- A remote provider MUST NOT be treated as the source of truth for agent-facing
  conversation state after a message has been synced into Ravi.
- Duplicate provider events MUST NOT create duplicate local messages (import is
  idempotent per provider message id).
- A raw email address MUST NOT become a canonical contact by itself; ingestion
  resolves through the contacts identity graph and keeps raw addresses as
  provenance.
- Mail events MUST carry local ids first and MUST NOT expose provider tokens,
  raw MIME, or full bodies to unauthorized consumers.
- `ravi.inbox.mail.received` MUST be emitted only after a new local inbox item
  exists for a local mailbox message, with structured `mail.from`/`mail.to`
  plus `fromText`/`toText` display strings.
- Provider credentials and full raw payloads MUST NOT be logged.
- The agent-facing send/reply path MUST go through the local outbox and MUST
  honor the `cli/mail` agent-first contract (dry-run by default, `--execute`
  to enqueue).
