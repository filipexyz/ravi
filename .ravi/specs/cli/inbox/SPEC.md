---
id: cli/inbox
title: "Console Delivery CLI Compatibility"
kind: capability
domain: cli
capability: inbox
status: draft
normative: true
owners:
  - ravi-dev
applies_to:
  - src/cli/commands/inbox.ts
  - src/inbox
  - src/daemon.ts
tags:
  - cli
  - console
  - delivery
  - legacy-inbox
  - nats
---

# Console Delivery CLI Compatibility

## Intent

This legacy CLI delivers Console-produced watch events into local Ravi through
local polling, a SQLite mirror, NATS publish, and replay/debug commands.

This OSS spec defines only the CLI and local plumbing contract. Console remains
the source of truth for server policy, auth, redaction, subscriptions, item
content, leasing, receipts, and watermarks.

`ravi inbox` is now reserved by `inbox/SPEC.md` for the local real inbox. The
Console event bridge SHOULD be called `console delivery` in new specs and new
code.

Existing `ravi inbox` delivery commands MAY remain as compatibility aliases
until the product inbox CLI exists, but they MUST NOT define the meaning of
Inbox going forward.

Watches are created and managed through `ravi watch`. Console delivery is the
technical path for watch events that were produced on the Console side.

## Boundary

- OSS Ravi MUST NOT embed proprietary Console policy, billing, hosting, or
  product rules.
- OSS Ravi MAY implement public CLI endpoints for a Console-compatible API.
- Console MUST remain authoritative for remote watch execution, delivery item
  visibility, authorization, redaction, payload shape, leases, and ack validity.
- Local Ravi owns only cloud-auth reuse, runner orchestration, local SQLite
  delivery mirror, NATS publish, local replay, status, and trigger integration.
- Local watches that can run on the user's machine SHOULD publish watch events
  directly through the local watch runner. Console watches SHOULD arrive through
  Console delivery and be normalized to the same watch event contract.

## Compatibility Commands

The compatibility CLI currently exposes:

```bash
ravi inbox status
ravi inbox enable
ravi inbox disable
ravi inbox poll --once
ravi inbox replay <item-id|local-row-id>
```

`ravi inbox items` MAY exist as a bounded local inspection helper while the
compatibility alias remains.

The target technical surface SHOULD be:

```bash
ravi console delivery status
ravi console delivery enable
ravi console delivery disable
ravi console delivery poll --once
ravi console delivery replay <item-id|local-row-id>
```

Commands consumed by agents MUST support machine-readable output.

## Auth

- The CLI MUST reuse `cli/cloud-auth` credentials.
- Required scopes are `console.inbox.read`, `console.inbox.subscribe`,
  `console.inbox.deliver`, and `console.inbox.ack`.
- Remote watch management scopes live in `cli/watch` and are intentionally
  separate from Console delivery scopes.
- The CLI MUST refresh through Console on auth-expired responses.
- If credentials are missing, invalid, revoked, or lack inbox scopes, the runner
  MUST skip or pause without deleting unrelated local mirror rows.
- OSS Ravi MUST NOT store Console refresh tokens anywhere except the configured
  cloud-auth credential store.

## Local Polling Contract

The local loop MUST follow this order:

1. Read and refresh cloud credentials.
2. Ensure or load the global Console inbox subscription.
3. Acquire the local inbox runner lock.
4. Send a cheap pulse with local generation/cursor/etag.
5. If there is no change, update only local status/timestamps and sleep.
6. If generation changed, poll/lease a bounded batch.
7. Persist each item to the local SQLite mirror.
8. Publish the canonical NATS event.
9. Mark the local item delivered.
10. Ack delivered to Console idempotently.

The no-change path MUST remain pulse-only. It MUST NOT lease items, write
Console receipts, or force a full Console inbox scan.

The runner MUST NOT ack delivered before local persistence and NATS publish have
completed for that item.

## Local Delivery Mirror

The SQLite mirror MUST store enough data to:

- resume after daemon restart;
- avoid duplicate watch event publishes for already-delivered items;
- retry Console ack for delivered but unacked items;
- show bounded status and item history;
- replay a locally stored item without creating a new Console item.

The mirror SHOULD key idempotency by `(console_url, organization_id, item_id)`.

## NATS Event Contract

The canonical subject is:

```text
ravi.console.inbox.item
```

This subject is the Console delivery envelope. When the item contains a watch
event, the delivery item `eventType` SHOULD use the Console namespace
`watch.<connector>.<event>`, such as `watch.github.release.published`.

The local delivery bridge SHOULD also publish the normalized watch subject defined
by `watch/SPEC.md`, such as `ravi.watch.github.release.published` or
`ravi.watch.npm.package.version_published`.

The payload MUST preserve stable fields from the Console event contract,
including:

- `version`
- `eventId`
- `sequence`
- `dedupeKey`
- `eventType`
- `category`
- `severity`
- `sensitivity`
- `organization`
- `project`
- `source`
- `actor`
- `target`
- `payload`
- `links`
- `delivery`
- `occurredAt`
- `createdAt`

Console delivery items SHOULD carry watch event payloads. Any connector-specific
payload with sensitive content MUST stay restricted by the Console API response:
no raw MIME, plaintext attachments, provider access tokens, or full unredacted
message bodies should be returned as ordinary remote delivery metadata.

Ravi Mail is the local exception for operator-owned automations. When a delivered
`mail.message.received` item references a message id, the local bridge MAY enrich
the local NATS payload by performing explicit authorized Console Mail `read`
calls for `subject`, `address_summary`, and `parsed_body` before local
persistence and publish. That enrichment MUST remain local to the user's runtime:
Console still owns auth/audit/decryption, and the remote delivery item stays
metadata-only. Existing Console wire contracts MAY still call it an inbox item,
but OSS Ravi MUST NOT implement mail selection or redaction policy.

When `mail/local-mailbox` is implemented, mail enrichment through this delivery
bridge MUST be treated as a compatibility ingestion path or provider event hint.
The durable agent-facing source of truth for email state MUST be the local
mailbox, not the delivery mirror. Enriched mail content SHOULD be persisted
through the local mailbox ingest path before agents rely on it as mailbox state.

When mail enrichment succeeds, the NATS JSON MUST include the complete parsed
email content at `payload.mail.content.text` and `payload.mail.content.html`
without truncation. It SHOULD also expose `payload.mail.subject`,
`payload.mail.addressSummary`, `payload.mail.bodyText`, and
`payload.mail.bodyHtml` for trigger prompts. Because the durable mirror stores
the exact NATS payload for replay, this intentionally stores the authorized
plaintext mail content in local SQLite for that user.

For GitHub/source-control watches, `category` SHOULD be `source_control`.
`source` and `target` SHOULD preserve the safe provider provenance defined in
`watch/console-provider`.

## Replay

Replay is local. Compatibility `ravi inbox replay` and target
`ravi console delivery replay` MUST republish the stored NATS payload from
SQLite and MUST NOT create a new Console delivery item.

Replay MUST preserve `eventId`, `sequence`, `dedupeKey`, `eventType`, and
original timestamps. Replay MAY add delivery metadata such as `replayed`,
`replayCount`, and `replayedAt`.

## Daemon Integration

`ravi daemon` SHOULD start the Console delivery runner automatically when:

- cloud credentials exist;
- required inbox scopes are present;
- local inbox polling is enabled;
- NATS is available.

The delivery runner MUST coordinate with itself through a local lock so only one
local loop leases/publishes/acks Console deliveries at a time.

## Acceptance Criteria

- `ravi console delivery status --json` reports credentials, scopes,
  subscriptions, cursor, generation, last poll/success/error, and pending local
  counts.
- Compatibility `ravi inbox status --json` MAY expose the same payload until the
  migration is complete.
- `ravi console delivery poll --once` runs one foreground tick and exits.
- No-change pulse does not poll/lease Console rows.
- Changed pulse leads to bounded poll, local persistence, NATS publish, local
  delivered mark, and Console ack in that order.
- Delivered-but-unacked items can be acked later without duplicate local publish.
- Replay republishes from the local mirror and preserves event identity.
- Console-produced watch events can be consumed by ordinary `ravi triggers`
  subscriptions through the normalized watch subject.
