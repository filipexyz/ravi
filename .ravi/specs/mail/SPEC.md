---
id: mail
title: Mail
kind: domain
domain: mail
capabilities:
  - local-mailbox
tags:
  - mail
  - local-first
  - providers
  - agents
applies_to:
  - src/mail
  - src/cli/commands/mail.ts
  - src/cli/commands/gmail.ts
  - src/inbox/mail-enrichment.ts
  - src/sync
owners:
  - ravi-dev
status: draft
normative: true
---

# Mail

## Intent

Mail is Ravi's local-first email domain.

The local Ravi runtime MUST expose a normalized mailbox model that agents can
read from and write to without treating any remote email provider as the agent
source of truth.

Ravi Mail through Console SHOULD be the default managed provider, but it MUST be
an adapter into the local mailbox model. Gmail, IMAP/SMTP, and future providers
SHOULD use the same local mailbox contract.

## Boundary

Ravi owns:

- local mailbox accounts and mailbox projections;
- normalized messages, threads, labels, addresses, attachments metadata, and
  outbox state;
- provider-neutral read, search, send, reply, draft, archive, and label
  behavior for agents;
- sync cursors, local retry, idempotency, and diagnostics;
- permission checks for agent access to local mailboxes.

Providers own:

- remote delivery;
- remote provider ids, history ids, page tokens, and delivery status;
- provider-specific capabilities and rate limits;
- provider credentials and refresh tokens through their existing auth systems;
- remote mailbox creation or provider routing when the provider supports it.

The OSS mail domain MUST NOT embed Console-only authorization policy, billing,
hosting, organization rules, provider credential custody, or remote database
schema.

## Local-First Rule

SQLite is the source of truth for what agents can inspect, search, cite, and act
on locally.

Remote providers MAY be the source of delivery facts. They MUST NOT be the
source of truth for agent-facing conversation state after a message has been
synced into Ravi.

Provider outage MUST NOT break local reads, local search over synced data,
draft creation, or outbox inspection.

## Identity Integration

Email addresses are platform identities with `channel=email`.

Mail ingestion MUST normalize email addresses and SHOULD resolve them through
the contacts identity graph. A raw email address MUST NOT become a canonical
contact by itself.

Mail records SHOULD carry:

- `contact_id` when the identity graph resolves a human or organization;
- `agent_id` when the address is owned by a Ravi agent;
- `platform_identity_id` when an email identity is known;
- raw email addresses as provenance.

Unknown or ambiguous addresses SHOULD create unresolved identity candidates or
duplicate suggestions through the contact write path, not direct contact merges.

## Public Surface

The agent-facing CLI SHOULD evolve toward local-first commands:

```bash
ravi mail accounts list
ravi mail accounts sync <account>
ravi mail mailboxes list
ravi mail messages list --mailbox <mailbox>
ravi mail messages read <message>
ravi mail messages search <query>
ravi mail threads read <thread>
ravi mail send --from <mailbox> --to <address> --subject <subject> --body <body>
ravi mail reply <message> --body <body>
ravi mail outbox status
```

Existing provider bridge commands MAY remain temporarily for compatibility, but
agent-facing read/send paths SHOULD go through the local mailbox and local
outbox once this domain is implemented.

Provider-specific operations SHOULD live under an explicit provider surface,
for example:

```bash
ravi mail providers list
ravi mail providers ravi-mail status
ravi mail providers gmail sync
```

## Events

The local mail domain SHOULD emit normalized events for triggers and agents:

- `ravi.mail.message.received`
- `ravi.inbox.mail.received`
- `ravi.mail.message.sent`
- `ravi.mail.message.updated`
- `ravi.mail.thread.updated`
- `ravi.mail.outbox.failed`
- `ravi.mail.provider.sync.failed`

Events MUST carry local ids first and provider ids as provenance. Events MUST
NOT expose provider tokens, raw MIME, full message bodies, or attachments unless
the consumer is explicitly authorized for that mailbox and the payload is a
local-only delivery path.

`ravi.inbox.mail.received` is the native inbox trigger subject for new actionable
email. It MUST be emitted only after a new local inbox item has been created for
a local mailbox message. Automations SHOULD listen to this subject for email
workflows instead of `ravi.console.inbox.item`.

## Relationship To Inbox And Sync

Inbox is Ravi's local attention and triage surface. It MUST NOT be the durable
mail source of truth.

The local mailbox MAY project unread/actionable mail into inbox items, but
durable mail content, threads, labels, attachments, and send state belong to the
local mailbox.

Console delivery events MAY notify Ravi that a provider message exists. Those
events SHOULD flow through local mailbox ingest before they become durable mail
state or real inbox items.

When Console delivers `mail.message.received`, Ravi SHOULD automatically ingest
the event into the local mailbox as a Ravi Mail provider event. If the delivery
payload has enough mailbox identity (`mailboxAddress` and provider message id),
the local runner MUST create or reuse the Ravi Mail account/mailbox, import the
message idempotently, and project the local message into inbox before marking the
Console item delivered. If Console enrichment returns safe message body content,
the local message MAY be stored as `full_local`; otherwise it MUST be
`preview_only` and still remain searchable by available metadata.

After that local projection creates a new inbox item, the native inbox event
`ravi.inbox.mail.received` MUST be the event consumers use for email automation.
The Console delivery subject remains diagnostic/compatibility plumbing.

The generic `sync` domain MAY mirror selected mail metadata or trace facts when
authorized, but raw mail bodies, attachments, provider credentials, and
local-only provider state MUST NOT be uploaded through generic sync by default.

## Acceptance Criteria

- Agents can list, read, search, send, and reply through local mailbox commands.
- Ravi Mail can act as the default provider without becoming a runtime
  dependency for local reads.
- Gmail and future providers can sync into the same local mailbox model.
- Duplicate provider events do not create duplicate local messages.
- Email identities are resolved through contacts/identity graph boundaries.
- Failed provider sync does not break local runtime behavior.
- Provider credentials and full raw payloads are not logged.
