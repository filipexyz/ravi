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
  - src/triggers/follow-owner.ts
  - src/daemon.ts
  - src/triggers/runner.ts
  - src/triggers/topic-catalog.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Page comment wake via triggers

## Intent

When `ravi pages ship` publishes a page, OSS arms a trigger so a later Console page comment wakes the session that shipped it. A session that is a Slack thread child does not outlive its work, so a ship made from a thread wakes the thread's durable parent instead. A page is one route on the project host, so the binding is per route: every page a session shipped wakes that session. Console delivers the comment through the Agent Inbox, only to the installation that published the commented version. The session name stays local; Console never receives it. OSS does not add a messaging channel, and it does not own comment fanout or history.

Anchors are out of scope.

## Invariants

1. A successful `pages ship` MUST create or reuse one trigger named `page-comment:<pageId>:<routePath>` on topic `ravi.watch.console.page.comment.created`. `<pageId>` is the stable site id Console returns from publish (list/create site id is only a fallback). A slug is not a page id. `<routePath>` is the shipped `--route` as Console stores it: leading slash, no trailing slash, `/` by default.
2. The trigger MUST bind `agentId` to the creator agent in the current session (`agentId` from tool context, else `RAVI_AGENT_ID`) and `replySession` to that session. Session target is `main`, so the turn runs in the reply session. A later ship of the same route from another session or agent MUST move the trigger to it (`rebound: true`): comments wake the session that shipped the route last. Cooldown is 0: each comment is its own event.
   When the current session is a Slack thread child, the creator MUST be resolved to the thread's durable parent first (`resolveDurableFollowOwner`): the parent's agent, the thread's account, and the parent's chat as `replySource`, without the thread id. The trigger MUST NOT address the child, because an active trigger addressing a thread blocks `sessions close-thread` (`THREAD_TRIGGERS_PENDING`), and the page outlives the thread. Several threads of one parent shipping the same route therefore keep one trigger on that parent (no `rebound`).
   Only a Slack thread child is resolved to a parent. A session key that carries `:thread:` but whose thread id is not a Slack timestamp (a thread of another channel, a task's own thread `agent:<agent>:thread:<id>`) has no Slack lifecycle to look up and no `sessions close-thread` to block: its ship MUST keep arming the trigger on that session, as it did before threads moved to their parent.
3. The filter MUST be generated with `validateFilter` and MUST fail closed. An invalid filter MUST NOT be persisted. A stored invalid filter for the same page MAY be rewritten to the canonical filter; a stored valid filter MUST be left unchanged.
4. The filter MUST require the route path (`payload.routePath` or root `routePath`). When `orgId` and `projectId` are known stable ids, the filter MUST also require them. A project slug MUST NOT be written as `projectId`. The filter MUST match both nested `payload.*` fields and the same fields hoisted on the event root, and MUST treat `siteId` as an alias of the bound page id and `organizationId` as an alias of `orgId`.
5. Ship MUST stay successful when follow cannot arm a trigger. The JSON result MUST include `commentFollow` with `ok: false` and `skipped` of `missing_page`, `missing_creator`, `invalid_filter`, or `unbound_agent`, or with `ok: false` and a `warning` when arming throws. A ship from a Slack thread child whose lifecycle or durable parent cannot be resolved (missing, ambiguous, or the parent is itself a thread) MUST report the second form, MUST NOT create or move a trigger, and MUST NOT fail the publish. The refusal is for a key with an expected Slack lifecycle (rule 2) and for nothing else.
6. Console Agent Inbox `eventType: page.comment.created` MUST be ingested by `publishInboxNatsEvents` and republished as `ravi.watch.console.page.comment.created`. `page.comment.resolved` MUST be ingested the same way onto `ravi.watch.console.page.comment.resolved`. v0 ship MUST NOT create a trigger for resolved. Sync ledger events MUST NOT be this path.
7. A matching event MUST wake the bound creator in that agent's main session. The prompt MUST use the catalog template (comment body and URL) and MUST NOT dump the raw event JSON. `payload.url` MUST stay as Console sent it when that field is non-empty. When it is missing or blank, the watch remap MUST set `payload.url` from inbox `links`: label `Page`, else the first `http://` or `https://` link, else label `Console`. When none of those match, `payload.url` MUST stay unset.
8. If the bound agent row is gone, activation `runtimeState` MUST be `unbound_agent`. The runner MUST NOT subscribe that trigger and MUST NOT create a session under `/tmp/ravi-<agentId>`.
9. Comments authored by the person behind the creator MUST still wake (they are how the operator asks the session for a change). Anchors MUST NOT grow a new contract in this version.
10. A ship MUST delete the v0 per-site trigger `page-comment:<pageId>` of the same site (`replacedTriggerId`), so a comment does not wake twice.
11. Route triggers armed while a thread's ships still woke the thread MUST be reconciled at daemon boot, before the trigger runner loads: every `page-comment:*` trigger whose `replySession` is a Slack thread child, open, closed or pruned, MUST move to that thread's durable parent (agent, account, session and chat). The repair MUST be idempotent, MUST leave a trigger whose thread cannot be verified as it was and log why, MUST NOT touch triggers whose name does not start with `page-comment:`, and MUST NOT stop boot on failure. A trigger addressed to another kind of thread (rule 2) is not a Slack thread child: the repair MUST leave it as it is and MUST NOT report it as a failure. The daemon MUST run the repair once, in `startDaemon`, after the runtime state is initialized and before the trigger runner starts, and a test MUST pin that wiring against `src/daemon.ts` itself. `sessions close-thread` MUST NOT perform this repair or rewrite recipients (see `channels/slack/threads`).

## Acceptance Criteria

- Shipping the same route twice from one session returns one trigger id, with `reused: true` on the second ship.
- Shipping the route from another session returns the same trigger id with `rebound: true`, now waking that session.
- Two routes on one host get two triggers; a comment on one does not wake the other's session.
- A filter with an unquoted page id does not match and is not saved.
- An inbox item `page.comment.created` becomes a watch event whose filter matches only that page, route, org, and project.
- The runner publishes one prompt to the creator and no session for a missing agent.
- A watch event keeps `payload.url` when Console sends it. A blank URL is filled from the Page link, else the first http(s) link, else the Console link. No links leaves `payload.url` unset.
- `page.comment.resolved` is in the topic catalog and is published from the inbox, with no ship-created trigger.
- A ship from a Slack thread arms the route's trigger on the thread's durable parent; the thread then closes without `THREAD_TRIGGERS_PENDING`, and the page's comments still match the trigger and wake the parent.
- Two threads of one parent shipping the same route (a shared index page) leave one trigger on the parent.
- A ship from a thread with no resolvable lifecycle publishes, reports `commentFollow.ok: false` with a warning, and creates no trigger.
- After boot, a `page-comment:*` trigger that still addressed a thread child addresses its parent; a second boot changes nothing.
- A ship from a thread of another channel or from a task's own thread arms the trigger on that session (`commentFollow.ok: true`), and the boot repair leaves such a trigger alone without a warning.
- Removing the repair from `startDaemon`, or moving it after the trigger runner starts, fails a test.
