---
id: pages/comment-follow
title: "Page comment wake via triggers"
kind: capability
domain: pages
capabilities:
  - comment-follow
tags:
  - pages
  - triggers
  - inbox
  - watch
applies_to:
  - src/pages/comment-follow.ts
  - src/cli/commands/pages.ts
  - src/watch/events.ts
  - src/watch/page-comment.ts
  - src/inbox/inbox-runner.ts
  - src/triggers/activation.ts
  - src/triggers/runner.ts
  - src/triggers/topic-catalog.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Page comment wake via triggers

## Intent

When `ravi pages ship` publishes a page, OSS arms a trigger so a later Console page comment wakes the agent that shipped it. Console delivers the comment through the Agent Inbox. OSS does not add a messaging channel, and it does not own comment fanout or history.

v0 destination is the creator agent bound at ship. Anchors are out of v0.

## Invariants

1. A successful `pages ship` MUST create or reuse one trigger named `page-comment:<pageId>` on topic `ravi.watch.console.page.comment.created`. `<pageId>` is the stable site id Console returns from publish (list/create site id is only a fallback). A slug is not a page id.
2. The trigger MUST bind `agentId` to the creator agent in the current session (`agentId` from tool context, else `RAVI_AGENT_ID`). Session target is `main`. Reuse MUST keep the original creator. A later ship MUST NOT rebind the trigger to a different agent.
3. The filter MUST be generated with `validateFilter` and MUST fail closed. An invalid filter MUST NOT be persisted. A stored invalid filter for the same page MAY be rewritten to the canonical filter; a stored valid filter MUST be left unchanged.
4. When `orgId` and `projectId` are known stable ids, the filter MUST also require them. A project slug MUST NOT be written as `projectId`. The filter MUST match both nested `payload.*` fields and the same fields hoisted on the event root, and MUST treat `siteId` as an alias of the bound page id and `organizationId` as an alias of `orgId`.
5. Ship MUST stay successful when follow cannot arm a trigger. The JSON result MUST include `commentFollow` with `ok: false` and `skipped` of `missing_page`, `missing_creator`, `invalid_filter`, or `unbound_agent`.
6. Console Agent Inbox `eventType: page.comment.created` MUST be ingested by `publishInboxNatsEvents` and republished as `ravi.watch.console.page.comment.created`. `page.comment.resolved` MUST be ingested the same way onto `ravi.watch.console.page.comment.resolved`. v0 ship MUST NOT create a trigger for resolved. Sync ledger events MUST NOT be this path.
7. A matching event MUST wake the bound creator in that agent's main session. The prompt MUST use the catalog template (comment body and URL) and MUST NOT dump the raw event JSON. `payload.url` MUST stay as Console sent it when that field is non-empty. When it is missing or blank, the watch remap MUST set `payload.url` from inbox `links`: label `Page`, else the first `http://` or `https://` link, else label `Console`. When none of those match, `payload.url` MUST stay unset.
8. If the bound agent row is gone, activation `runtimeState` MUST be `unbound_agent`. The runner MUST NOT subscribe that trigger and MUST NOT create a session under `/tmp/ravi-<agentId>`.
9. v0 MUST NOT filter out comments authored by the creator. Anchors MUST NOT grow a new contract in this version.

## Acceptance Criteria

- Shipping the same page twice returns one trigger id, with `reused: true` on the second ship, still bound to the first creator.
- A filter with an unquoted page id does not match and is not saved.
- An inbox item `page.comment.created` becomes a watch event whose filter matches only that page, org, and project.
- The runner publishes one prompt to the creator and no session for a missing agent.
- A watch event keeps `payload.url` when Console sends it. A blank URL is filled from the Page link, else the first http(s) link, else the Console link. No links leaves `payload.url` unset.
- `page.comment.resolved` is in the topic catalog and is published from the inbox, with no ship-created trigger.
