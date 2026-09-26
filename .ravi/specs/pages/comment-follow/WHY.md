---
id: pages/comment-follow
title: "Page comment wake rationale"
kind: capability
domain: pages
capability: comment-follow
status: active
---

# Why page comments wake through triggers

## Problem

A shipped page can receive comments in Console. The creator agent should hear about them without a new channel, a sync-ledger subscriber, or a second messaging product. Fanout and history stay in Console. OSS only needs a durable binding from the page to the agent that shipped it.

## Design

This follows bug follow and gh-follow:

- Console delivers `page.comment.created` on the Agent Inbox, not the sync ledger. The sync path never publishes to NATS.
- `publishInboxNatsEvents` already turns `watch.*` inbox items into `ravi.watch.<connector>.<event>`. Page comments do not use the `watch.` prefix, so the inbox bridge special-cases `page.comment.created` and `page.comment.resolved` onto `ravi.watch.console.page.comment.created` and `ravi.watch.console.page.comment.resolved`.
- `pages ship` creates or reuses `page-comment:<siteId>` filtered to that id. Site ids stay stable across re-ships of the same slug. The publish response id wins over the slug.
- The trigger row is the durable creator binding. v0 does not add another table.

## Caveats

- **Gone creator.** `getAgent` returning null used to fall back to `/tmp/ravi-<id>` and could open a phantom session. Those triggers now stay `unbound_agent` and do not fire. Recreating an agent with the same id does not revive the subscription until the next trigger refresh.
- **Duplicate ship.** A second ship reuses the trigger and keeps the first creator. It does not move the binding to whoever shipped again.
- **Comment from the creator.** v0 does not suppress the creator's own comments. Console owns fanout. The bound agent still wakes.
- **Anchors.** Comment anchors are left in the payload and are not part of the filter or the prompt contract.
- **Resolved.** The inbox subject is reserved. Ship does not arm it.
- **Missing creator.** A ship from a CLI session with no agent id records `missing_creator` and does not guess the default agent.
- **Project slug.** An explicit `--project slug` is not a `projectId`. The filter includes `projectId` only when Console or scope returns an id.
- **Page URL.** The catalog template reads `payload.url`. Newer Console emits put the URL there. Older emits only put it in inbox `links` (`Page`, otherwise the first http(s) link, otherwise `Console`). The watch remap fills `payload.url` from those links when the payload field is missing or blank, and leaves a present URL unchanged.

## Rejected

- A new comment channel or local comment ledger. Console already stores the thread.
- Listening on `ravi.console.inbox.item` for every inbox event. That wakes on unrelated deliveries.
- Subscribing to the raw event type `page.comment.created` with no publisher. Triggers only fire on the NATS subject the inbox bridge publishes.
