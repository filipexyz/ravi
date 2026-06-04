---
id: mail/local-mailbox
title: Local Mailbox Checks
kind: checks
domain: mail
capability: local-mailbox
status: draft
normative: false
owners:
  - ravi-dev
---

# Local Mailbox Checks

## Schema

- Lazy init creates all mail tables without cloud auth.
- Indexes exist for provider id, RFC message id, mailbox, thread, status,
  cursors, and outbox status.
- Mail tables do not contain provider access tokens or refresh tokens.

## Ingest

- Ravi Mail inbound metadata imports into local `mail_messages`.
- Gmail inbound metadata imports into the same local shape.
- Duplicate provider events do not create duplicate local messages.
- A message with `Message-ID`, `In-Reply-To`, and `References` attaches to the
  expected local thread.
- Missing RFC ids still dedupe safely by provider immutable ids.

## Identity

- Email addresses normalize to `platform_identity(channel=email)`.
- Unknown addresses create unresolved identity candidates or remain unresolved;
  they do not create canonical contacts directly.
- Agent-owned email identities do not merge into human contacts.

## Read/Search

- `ravi mail messages list --json` is machine-readable.
- `ravi mail messages read <id> --json` returns local ids, thread id, mailbox
  id, safe body, and provider provenance.
- Local reads keep working when provider auth is missing.
- Search does not require a provider request for already-synced data.

## Outbox

- `ravi mail send` creates a local message and `mail_outbox` row before remote
  send.
- Retrying the same outbox row is idempotent.
- Provider failure preserves a recoverable row with sanitized error code.
- Provider success updates local message status and provider provenance.

## Permissions

- Agent without `mailbox:read` cannot read body content.
- Agent without `mailbox:send` cannot send from that mailbox.
- Listing metadata can be allowed separately from reading full bodies.
- Attachments require explicit body/attachment permission.

## Security And Logging

- Logs do not include tokens, raw MIME, full body text, or attachments.
- Trace export redacts or previews mail body content by default.
- Provider errors are sanitized before CLI, logs, and events.

## Provider Sync

- Ravi Mail provider reuses `src/cloud-auth/client.ts`.
- Gmail provider reuses connector credentials.
- Cursor advancement happens only after local ingest commit.
- Provider sync batches by count and bytes.

## Suggested Validation Commands

```bash
bun test src/mail/*.test.ts src/cli/commands/mail.test.ts
bun test src/inbox/mail-enrichment.test.ts
bun run typecheck
bun run build
```
