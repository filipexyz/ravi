---
id: mail/local-mailbox
title: Local Mailbox Decisions
kind: why
domain: mail
capability: local-mailbox
status: draft
normative: false
owners:
  - ravi-dev
---

# Local Mailbox Decisions

## Why A Local Mailbox

Agents need a stable email world model. If every email action calls a remote
provider directly, agents lose continuity when a provider is down, rate-limited,
or returns a different shape.

A local mailbox lets agents cite local message ids, inspect prior mail offline,
retry sends, and reason over one normalized thread/message model.

## Why Mailbox Is Not Inbox

Inbox is the local attention and triage feed. It answers "what needs attention?"

Mailbox answers "what email state exists?" Email needs durable message state,
threading, labels, address resolution, outbox retry, and provider cursors. Those
are mailbox concerns.

Inbox can project unread/actionable mail, but it should not own mail state.

## Why Ravi Mail As Default Provider

Ravi Mail already exists in Console and gives us a managed default for domains,
mailboxes, receive, read, and send. It is the best default provider for new
agents.

Keeping it as a provider adapter avoids making Console a hard runtime
dependency. If Ravi Mail is unavailable, local synced data remains usable.

## Why Provider-Neutral Schema

Gmail, Ravi Mail, IMAP, and future providers all expose different ids, labels,
threading hints, and delivery results. A provider-neutral local schema prevents
agents from learning provider quirks.

Provider details stay available as provenance for diagnostics.

## Why Email Addresses Use Contacts Identity Graph

An email address is one way an actor appears on a platform. It is not the actor
itself.

Using the existing contacts identity graph keeps email aligned with WhatsApp,
phone, Telegram, and other channels. It also prevents accidental contact merges
from weak evidence such as display name or shared subject context.

## Rejected Alternative: Provider As Source Of Truth

Using Gmail or Ravi Mail directly as the agent source of truth is simpler at
first, but it creates duplicated CLI behavior, provider-specific prompts, poor
offline behavior, and no unified outbox.

The local mailbox is more work upfront, but it gives the runtime one durable
contract.
