---
id: cli/ravi-link
title: "Why ravi link asks the person to approve"
---

# ravi link / WHY

## Why the person approves in the browser

The first version bound the turn's contact to whoever ran `ravi login` on the
daemon host. In a channel, every author who asked would have been linked to
the operator's Console account and could act as the operator. Only the person
can prove their Console identity, so the Console writes the link from their
own approval and the daemon session is just the transport.

## Why the link goes by private message

The approval URL is a bearer secret for a few minutes. A private message to
the author is the possession proof that it reaches the right person; posting
it in the channel would let anyone approve. Turning unfurling off keeps link
previews from fetching it. When the platform knows the author's email, the
Console also checks it against the approver.

## Why no flags

A flag that names a contact or user would let an agent or a confused operator
link someone else. The author of the message is the only subject.

## Why the Console's installation id

`ravi login` used to store a random local id the Console had never seen, so
every link call failed as `PAYLOAD_INVALID` ("Unknown installation"). The
Console returns its own `localInstallation.id`; the CLI now stores that, and
a persisted installation key makes re-logins reuse it.

## Why a daemon watcher

The approval happens in the browser, outside any turn. The daemon polls the
request so it can confirm in the chats, and re-checks cached bindings so a
revoke on the Console reaches this install within minutes.

## Follow-ups

- Opening the person's Ravi session from a Pages viewer assertion through the
  bridge (widgets and chat).
- `ravi link` started from a Page.
- A Console push instead of polling.
