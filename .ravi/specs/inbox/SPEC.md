---
id: inbox
title: Inbox
kind: domain
domain: inbox
capabilities:
  - local-items
  - triage
  - projections
tags:
  - inbox
  - local-first
  - agents
  - triage
  - mail
applies_to:
  - src/inbox
  - src/mail
  - src/watch
  - src/triggers
  - src/cli/commands/inbox.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Inbox

## Intent

Inbox is Ravi's local-first attention and triage surface.

It is the real inbox that operators and agents inspect when they need to know
what arrived, what needs action, and what has already been handled.

Inbox MUST NOT mean "Console delivery queue" in product language. Console
delivery is a bridge that may feed inbox items, but it is not the inbox product.

## Naming Contract

- `inbox`: local attention/work queue for humans and agents.
- `mailbox`: durable email store and email-specific operations.
- `mail`: email domain and CLI surface.
- `console delivery`: technical bridge for Console-produced remote events.
- `watch`: event source configuration and watch event production.

`ravi inbox` SHOULD be reserved for the local real inbox.

Existing `ravi inbox` Console-delivery commands MAY remain as compatibility
aliases during migration, but new specs and new code SHOULD call that surface
`console delivery`, not inbox.

## Boundary

Inbox owns:

- local item lifecycle: `open`, `seen`, `assigned`, `snoozed`, `done`,
  `archived`, `dismissed`;
- local triage metadata: priority, due time, owner, tags, source, and reason;
- projections from mail, chats, watches, approvals, tasks, calls, and system
  events;
- agent-facing list/read/search/triage commands;
- item-level audit events for user and agent actions.

Inbox does not own:

- email message bodies, threads, labels, or send outbox;
- Console watch leasing, polling, or remote ack;
- provider credentials;
- contact identity resolution;
- task source of truth;
- chat/session history source of truth.

## Source Relationship

Inbox items are projections or actionable pointers.

Examples:

- A new email in `mail/local-mailbox` MAY create an inbox item pointing to
  `mail_message_id` and `mail_thread_id`.
- A Console watch event MAY create an inbox item after the console delivery
  bridge persists and publishes the event.
- A pending approval MAY create an inbox item pointing to the approval record.
- A missed call MAY create an inbox item pointing to call/run state.

The source domain remains authoritative for its own data. Inbox owns the local
attention state around that source item.

## Data Model

The implementation SHOULD use local SQLite tables such as:

### `inbox_items`

Fields:

- `id`
- `source_domain`: `mail`, `watch`, `chat`, `approval`, `task`, `call`,
  `system`, or future domain
- `source_type`
- `source_id`
- `dedupe_key`
- `title`
- `summary`
- `status`: `open`, `seen`, `assigned`, `snoozed`, `done`, `archived`,
  `dismissed`
- `priority`: `low`, `normal`, `high`, `urgent`
- `assigned_to_agent_id`
- `assigned_to_contact_id`
- `snoozed_until`
- `occurred_at`
- `created_at`
- `updated_at`
- `metadata_json`

`dedupe_key` MUST prevent duplicate inbox items for repeated source events.

### `inbox_item_events`

Append-only audit for item lifecycle changes.

Fields:

- `id`
- `item_id`
- `event_type`
- `actor_type`: `contact`, `agent`, `system`, or `unknown`
- `actor_id`
- `payload_json`
- `created_at`

## CLI Surface

The product CLI SHOULD expose:

```bash
ravi inbox list
ravi inbox read <item>
ravi inbox search <query>
ravi inbox done <item>
ravi inbox snooze <item> --until <time>
ravi inbox archive <item>
ravi inbox sources
```

All commands consumed by agents MUST support `--json`.

Console delivery diagnostics SHOULD move to a separate technical surface such
as:

```bash
ravi console delivery status
ravi console delivery poll --once
ravi console delivery items
ravi console delivery replay <item>
```

Compatibility aliases MAY exist temporarily, but human-facing docs SHOULD stop
describing Console delivery as "inbox".

## Mail Projection

The local mailbox is the source of truth for email messages.

Inbox MAY project mailbox messages into inbox items when the message is
actionable or unread for an operator/agent. Inbox MUST keep only enough
mail-specific fields to list and triage; body, thread, labels, attachments, and
send state stay in `mail/local-mailbox`.

When a new inbound email creates a new local inbox item, the native inbox MUST
publish:

```text
ravi.inbox.mail.received
```

This is the agent/operator automation subject for new email. It MUST be distinct
from `ravi.console.inbox.item`, which is only the Console delivery mirror.

The native inbox email event payload MUST carry local ids first:

- `inboxItemId`
- local `mail.messageId`
- `mail.threadId`
- `mail.mailboxId`
- `sourceDomain: "mail"`
- safe list/triage fields such as subject, snippet, sender summary, status,
  priority, and timestamps

The native inbox email event MUST NOT expose provider tokens, raw MIME,
attachments, `bodyText`, `bodyHtml`, or Console delivery-only leasing fields.
Repeated provider delivery or local replay of the same mail message MUST NOT
emit another new-email inbox event.

## Watch Projection

Watch events are source events. Inbox MAY project them into attention items, but
ordinary triggers MAY also consume watch events directly without creating inbox
items.

Console-produced watch events MUST pass through console delivery before they can
be projected into inbox or published to triggers.

## Acceptance Criteria

- `ravi inbox` is specified as a local real inbox, not Console delivery.
- Mail, watch, approval, and system events can project into inbox without
  becoming source-of-truth data there.
- New local mail projections emit `ravi.inbox.mail.received`, not
  `ravi.console.inbox.item`.
- Inbox item lifecycle changes are audited locally.
- Duplicate source events do not create duplicate inbox items.
- Existing Console delivery behavior has a migration path away from the inbox
  product name.
