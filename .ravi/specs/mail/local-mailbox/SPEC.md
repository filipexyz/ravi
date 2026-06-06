---
id: mail/local-mailbox
title: Local Mailbox
kind: capability
domain: mail
capability: local-mailbox
tags:
  - mail
  - local-first
  - sqlite
  - outbox
  - agents
applies_to:
  - src/mail
  - src/mailbox
  - src/cli/commands/mail.ts
  - src/inbox/mail-enrichment.ts
  - src/sync
owners:
  - ravi-dev
status: draft
normative: true
---

# Local Mailbox

## Intent

The local mailbox is the durable email store that Ravi agents use as their email
world model.

It MUST normalize messages from Ravi Mail, Gmail, IMAP/SMTP, and future
providers into one local SQLite model. Providers are adapters; the local mailbox
is the source of truth for synced agent-facing state.

## Non-Goals

- This spec does not implement Console policy or provider credential custody.
- This spec does not require cloud sync to use mail locally.
- This spec does not make raw MIME or attachments globally visible to agents.
- This spec does not replace the contacts identity graph.

## Source Of Truth Invariants

- SQLite MUST own local mailbox projections.
- Provider sync MUST be optional and best-effort.
- Provider failures MUST NOT break local reads, search, or draft/outbox writes.
- All writes that agents initiate MUST create local state before remote delivery
  is attempted.
- Remote provider ids MUST be stored as provenance, not as primary local ids.
- Provider-specific behavior MUST stay behind provider adapters.

## Data Model

The implementation SHOULD lazy-init a `mail` schema in local SQLite.

### `mail_accounts`

Provider account configured for local sync.

Fields:

- `id`
- `provider`: `ravi-mail`, `gmail`, `imap-smtp`, or future provider
- `display_name`
- `status`: `active`, `paused`, `auth_required`, `disabled`
- `default_mailbox_id`
- `credentials_ref`
- `capabilities_json`
- `settings_json`
- `created_at`
- `updated_at`

`credentials_ref` MUST point to an existing auth/connector credential store. It
MUST NOT contain provider tokens.

### `mail_mailboxes`

Local mailbox/address projection.

Fields:

- `id`
- `account_id`
- `address`
- `normalized_address`
- `display_name`
- `role`: `primary`, `alias`, `shared`, `system`, or `unknown`
- `status`: `active`, `paused`, `disabled`
- `provider_mailbox_id`
- `is_default`
- `last_synced_at`
- `metadata_json`
- `created_at`
- `updated_at`

`normalized_address` SHOULD be lowercased and Unicode-normalized where
appropriate.

### `mail_threads`

Provider-neutral email thread.

Fields:

- `id`
- `subject_normalized`
- `latest_message_at`
- `last_local_message_id`
- `participants_json`
- `provider_thread_refs_json`
- `metadata_json`
- `created_at`
- `updated_at`

Threading SHOULD use RFC `Message-ID`, `In-Reply-To`, `References`, provider
thread ids, and normalized subject fallback in that order.

### `mail_messages`

Normalized message record.

Fields:

- `id`
- `thread_id`
- `mailbox_id`
- `account_id`
- `direction`: `inbound`, `outbound`, `draft`, `system`
- `status`: `received`, `queued`, `sending`, `sent`, `delivered`, `failed`,
  `archived`, `trashed`, or `spam`
- `rfc_message_id`
- `provider_message_id`
- `provider_thread_id`
- `provider_history_id`
- `subject`
- `subject_normalized`
- `snippet`
- `body_text`
- `body_html`
- `body_redaction_status`: `full_local`, `preview_only`, `redacted`, or
  `missing`
- `date_header_at`
- `received_at`
- `sent_at`
- `created_at`
- `updated_at`
- `raw_headers_json`
- `safe_payload_json`
- `provider_provenance_json`

The local message id MUST be stable and provider-neutral. A provider id MAY be
used to derive it only if scoped by provider/account/mailbox and protected by an
idempotency key.

### `mail_message_addresses`

Normalized address rows per message.

Fields:

- `id`
- `message_id`
- `kind`: `from`, `to`, `cc`, `bcc`, `reply_to`, `sender`
- `address`
- `normalized_address`
- `display_name`
- `contact_id`
- `agent_id`
- `platform_identity_id`
- `raw_json`

Address resolution MUST use the contacts identity graph write/read path.

### `mail_labels`

Canonical and provider label mapping.

Fields:

- `id`
- `mailbox_id`
- `name`
- `role`: `inbox`, `sent`, `draft`, `archive`, `trash`, `spam`, `custom`
- `provider_label_id`
- `metadata_json`

Messages and labels SHOULD be related through a join table so provider label
changes do not mutate message identity.

### `mail_attachments`

Attachment metadata.

Fields:

- `id`
- `message_id`
- `filename`
- `content_type`
- `size_bytes`
- `sha256`
- `local_blob_ref`
- `provider_attachment_id`
- `redaction_status`
- `metadata_json`

Attachment content MUST be opt-in. Metadata MAY be synced locally by default.
Provider/import paths MUST replace a message's attachment metadata
idempotently when the provider event is replayed. Replays MUST NOT duplicate
attachments for the same local message.

### `mail_sync_cursors`

Cursor per account, mailbox, folder/label, and provider stream.

Fields:

- `id`
- `account_id`
- `mailbox_id`
- `provider`
- `cursor_type`
- `cursor_value`
- `watermark_at`
- `status`
- `last_success_at`
- `last_error_code`
- `updated_at`

### `mail_outbox`

Local outbound queue.

Fields:

- `id`
- `mailbox_id`
- `account_id`
- `message_id`
- `operation`: `send`, `reply`, `draft`, `update_draft`, `delete_draft`
- `idempotency_key`
- `payload_json`
- `status`: `pending`, `leased`, `sending`, `sent`, `acked`, `failed`, `dead`
- `attempt_count`
- `next_attempt_at`
- `last_error_code`
- `provider_result_json`
- `created_at`
- `updated_at`
- `acked_at`

Retries MUST be idempotent.

## Idempotency And Dedupe

Inbound ingest MUST dedupe by:

1. `provider + account_id + provider_message_id`;
2. `mailbox_id + rfc_message_id`;
3. provider-specific immutable history/event id when available;
4. local idempotency key for imported fixtures or replay.

If two providers expose the same RFC message to different mailboxes, Ravi SHOULD
store separate mailbox message projections and MAY link them by thread or
dedupe group.

## Agent Access

Agents MUST use the local mailbox API or CLI for ordinary mail work. They
SHOULD NOT call Gmail, Ravi Mail, or provider bridges directly unless they are
performing diagnostics or provider setup.

Agent-facing read responses SHOULD expose:

- local message id;
- thread id;
- mailbox id and address;
- subject;
- safe body text/html according to permission;
- participants resolved through contacts when available;
- provider provenance only when useful for debugging.

## Permissions

Mail permissions SHOULD be object scoped:

- `mailbox:read`
- `mailbox:search`
- `mailbox:send`
- `mailbox:manage`
- `mail-provider:sync`
- `mail-provider:manage`

Sending MUST require permission for the selected `mailbox_id` or address. A
default mailbox MUST NOT let an agent send from another mailbox.

Reading full bodies or attachments MAY require stronger permission than listing
metadata.

## Local Events

The local mailbox SHOULD publish events after local persistence:

```text
ravi.mail.message.received
ravi.inbox.mail.received
ravi.mail.message.sent
ravi.mail.message.updated
ravi.mail.thread.updated
ravi.mail.outbox.failed
```

Event payloads MUST include local ids and MAY include provider ids as
provenance. Native inbox mail received payloads MUST include structured
sender/recipient lists (`mail.from`, `mail.to`) and exact display strings
(`mail.fromText`, `mail.toText`) so templates can render `De`/`Para` without raw
JSON. They MUST NOT include provider tokens or raw MIME.

Native inbox mail received payloads MAY include `mail.attachments` metadata
after local persistence. Each attachment entry MUST be metadata-only: local id,
provider attachment id, filename, content type, size, SHA-256, redaction/scan
status, and whether a local blob ref exists. It MUST NOT include raw bytes,
remote URLs, provider tokens, raw MIME, or decrypted attachment content.

`ravi.inbox.mail.received` belongs to the native inbox projection, not to the
Console delivery mirror. It SHOULD be emitted only when a new inbound local mail
message creates a new inbox item; idempotent replays of the same provider
message MUST NOT emit it again.

## Provider Sync

Provider sync MUST write to local SQLite before acknowledging or marking a
remote event as consumed when the provider contract supports ack/receipts.

Outbound send MUST write `mail_outbox` first. Provider send then consumes local
outbox rows and updates local message/outbox state with provider delivery facts.

Provider sync SHOULD be batch-oriented and bounded by count and bytes. It MUST
NOT make one remote request per small delta when the provider supports batch or
page windows.

## Relationship To Inbox

Inbox is a local attention and triage projection. It is not the mailbox.

The local mailbox MAY create or update inbox items for unread/actionable mail,
but mailbox state remains authoritative for message bodies, threads, labels,
attachments, and send/outbox state.

Console delivery MAY deliver `mail.message.received` notifications from Console.
The local mailbox MUST treat those notifications as ingest triggers or provider
event hints, not as durable mail state by themselves.

The Console inbox runner MUST attempt local mailbox ingest automatically for
`mail.message.received` before it marks the Console delivery item as delivered
or acked. For Ravi Mail events, the runner SHOULD reuse an active local
`ravi-mail` account or create a local account projection with a non-secret
`credentials_ref`, then create/reuse the addressed mailbox and import the
message idempotently by provider message id.

If Console delivery enrichment fetches message body content, the enriched result
SHOULD be persisted through the local mailbox ingest path. The delivery mirror
MUST remain a delivery/debug mirror.

If Console delivery enrichment fetches attachment metadata, the local mailbox
ingest path MUST persist those attachments before the local inbox projection is
emitted. Console delivery metadata MUST NOT be trusted as mailbox state until it
has been imported into the local mailbox tables.

If enrichment fails but the event still includes provider message id and mailbox
address, the runner SHOULD import a metadata-only `preview_only` message so
agents can see the new mail and retry/read later. If the event lacks enough
mailbox identity to create a safe local message, the runner MAY skip mailbox
ingest and keep only the delivery mirror with a sanitized skip reason.

Automations that need to react to new local email SHOULD listen to
`ravi.inbox.mail.received`. `ravi.console.inbox.item` is diagnostic delivery
plumbing and MUST NOT be treated as the durable local email event.

## Acceptance Criteria

- Local schema initializes without requiring cloud auth.
- A message imported from Ravi Mail is readable locally after provider outage.
- A Gmail message and a Ravi Mail message normalize to the same message shape.
- Duplicate provider events are idempotent.
- Threading works through `Message-ID`, `In-Reply-To`, `References`, and provider
  thread ids.
- Sending creates a local outbox row before remote provider call.
- Failed send keeps a recoverable outbox row.
- Agent permission checks block unauthorized mailbox read/send.
- Raw tokens, raw MIME, and full bodies are not logged.
