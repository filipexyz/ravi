---
id: mail/local-mailbox/provider-sync
title: Mail Provider Sync
kind: feature
domain: mail
capability: local-mailbox
feature: provider-sync
tags:
  - mail
  - providers
  - sync
  - ravi-mail
  - gmail
applies_to:
  - src/mail
  - src/mail/client.ts
  - src/cli/commands/mail.ts
  - src/cli/commands/gmail.ts
  - src/link/connectors.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Mail Provider Sync

## Intent

Mail provider sync moves provider-specific email state into and out of the local
mailbox without making any provider the agent-facing source of truth.

Ravi Mail SHOULD be the default provider. Gmail, IMAP/SMTP, and future providers
SHOULD implement the same adapter contract.

## Provider Adapter Contract

A provider adapter SHOULD expose:

```ts
interface MailProviderAdapter {
  provider: string;
  listMailboxes(input: ListMailboxesInput): Promise<MailboxPage>;
  pullMessages(input: PullMessagesInput): Promise<MessagePage>;
  sendOutboxBatch(input: SendOutboxBatchInput): Promise<SendOutboxBatchResult>;
  applyRemoteMutation?(input: RemoteMutationInput): Promise<RemoteMutationResult>;
  getCapabilities(input: ProviderCapabilitiesInput): Promise<MailProviderCapabilities>;
}
```

Adapters MUST return normalized provider facts. They MUST NOT mutate contacts,
agents, sessions, or local mailbox projections directly. The local mailbox
service owns projection writes.

## Ravi Mail Provider

The Ravi Mail provider MUST reuse the existing cloud auth client and credential
store.

It MAY use Console public endpoints for domains, mailboxes, message metadata,
message reads, and send operations.

It MUST NOT depend on Console internals, remote database schema, R2, Hyperdrive,
billing policy, or proprietary authorization code in OSS.

Ravi Mail read endpoints MAY return remote decrypted payloads only after
authorization. Once imported, authorized local content belongs to local SQLite
for that user's runtime.

## Gmail Provider

The Gmail provider SHOULD reuse the existing connector capability bridge instead
of creating a second Google token store.

Gmail-specific ids such as `message.id`, `threadId`, labels, history ids, and
page tokens MUST be stored as provider provenance or cursors.

Gmail send SHOULD write local outbox first and then call the connector send
capability.

## IMAP/SMTP Provider

An IMAP/SMTP provider MAY be added later.

IMAP `UIDVALIDITY`, `UID`, folder path, and mod-sequence values SHOULD be
treated as provider cursor/provenance. SMTP delivery ids SHOULD be stored as
provider send results.

## Inbound Flow

Expected provider pull flow:

```text
load active mail account
  -> read cursor window
  -> provider adapter pulls bounded page
  -> normalize provider messages
  -> local mailbox ingest transaction
  -> resolve email platform identities
  -> update cursor after local commit
  -> publish local mail events
```

Provider pull MUST NOT update the cursor past messages that failed local ingest.

## Outbound Flow

Expected provider send flow:

```text
agent command
  -> local permission check
  -> create local draft/message
  -> enqueue mail_outbox row
  -> provider adapter sends bounded outbox batch
  -> update local message/outbox state
  -> publish local mail events
```

Remote send failures MUST preserve the outbox row with a sanitized error code
and retry/backoff metadata.

## Batching

Provider sync SHOULD be bounded by:

- maximum message count;
- maximum payload bytes;
- maximum runtime per tick;
- provider rate-limit hints.

Adapters MUST avoid one remote request per small local delta when the provider
supports batch/page windows.

## Error Handling

Authentication failures SHOULD set the account status to `auth_required` and
leave local mail readable.

Rate limits and provider 5xx responses SHOULD retry with backoff.

Provider validation errors SHOULD mark affected outbox rows failed or dead with
a sanitized error code.

No provider error path may log tokens, raw MIME, full body text, attachments, or
provider secrets.

## Capabilities

Provider capabilities SHOULD be explicit:

- `readMetadata`
- `readBody`
- `send`
- `reply`
- `draft`
- `labels`
- `archive`
- `trash`
- `historyCursor`
- `webhook`
- `batchSend`
- `batchRead`

The local CLI and agents SHOULD consult capabilities before offering actions.

## Acceptance Criteria

- Ravi Mail sync works with existing cloud auth.
- Gmail sync works with existing connector credentials.
- Provider credentials are never copied into mail tables.
- Cursor advancement is transactional with local ingest success.
- Provider outage does not block local reads or draft/outbox writes.
- Outbound retry is idempotent.
- Provider-specific ids are visible for diagnostics but are not primary local
  ids.
