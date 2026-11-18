# Page comment wake via triggers / CHECKS

## Ship binding

- `pages ship` with a creator agent MUST create one trigger named `page-comment:<pageId>:<routePath>` on `ravi.watch.console.page.comment.created`, session `main`, cooldown 0, bound to that agent and `replySession` to the shipping session.
- `<pageId>` MUST be the site id returned by publish. A slug-only site MUST NOT arm a trigger (`skipped: missing_page`).
- A second ship of the same route from the same session MUST reuse that trigger id unchanged.
- A ship of the same route from another session or agent MUST reuse the trigger id and move `agentId`, `accountId`, `replySession` and `replySource` to the new shipper (`rebound: true`).
- A different route on the same site MUST get its own trigger.
- A ship MUST delete the v0 `page-comment:<pageId>` trigger of that site and report `replacedTriggerId`.
- Ship without an agent in context MUST return `commentFollow.skipped: missing_creator` and MUST NOT insert a trigger.
- Follow failure MUST NOT fail the ship that already published.
- A ship from a Slack thread MUST arm the trigger on the thread's durable parent (`replySession` the parent's name, `agentId` the parent's agent, `replySource` the parent's chat without `threadId`), MUST NOT leave an active trigger addressing the child, and the child MUST then close without `THREAD_TRIGGERS_PENDING`.
- Two threads of one parent shipping the same route MUST keep one trigger on the parent and MUST NOT report `rebound`.
- A ship from a Slack thread child whose lifecycle or parent cannot be resolved MUST publish, return `commentFollow.ok: false` with a warning naming the unresolved thread, and MUST NOT insert or move a trigger.
- A ship from a session whose key carries `:thread:` but whose thread id is not a Slack timestamp (another channel's thread, a task's `agent:<agent>:thread:<id>`) MUST arm the trigger on that session, unchanged. The same keys MUST NOT be refused by `resolveDurableFollowOwner` with `refuse: "slack-thread"` (the page comment rule), by name, by key or with a non-Slack source that carries a thread id; the same shapes with a Slack timestamp id MUST still be refused. With the default rule (the PR follow and `ravi pr publish`) those keys MUST still be refused.
- `repairThreadBoundPageCommentFollows` MUST move every `page-comment:*` trigger addressed to an open, closed or pruned thread child to that thread's durable parent, MUST be idempotent, MUST leave unverifiable triggers untouched and report them, MUST leave a trigger on another kind of thread untouched without reporting a failure, and MUST NOT touch triggers whose name does not start with `page-comment:`. The daemon MUST run it at boot before the trigger runner loads and MUST NOT stop boot when it fails.
- The daemon's boot step (`repairThreadBoundPageCommentFollowsAtBoot` in `src/daemon.ts`) MUST be run as written there, without starting the daemon: it moves a thread-bound trigger so the thread then closes, logs a warning for each trigger it could not verify, is silent when nothing moves, and logs an error without throwing when the repair itself fails. `startDaemon` MUST call it exactly once, after `initializeRuntimeState()` and before `await startTriggerRunner()`.

## Filters

- `pageCommentFilter` MUST pass `validateFilter`.
- The filter MUST match `payload.pageId`, root `pageId`, `payload.siteId`, and root `siteId` for the bound id, and MUST reject a different page id.
- The filter MUST require `payload.routePath` or root `routePath` equal to the bound route, and MUST reject another route or an event without a route path.
- When org and project ids are present, the filter MUST reject a different org id or project id.
- An unquoted filter such as `data.pageId == site_1` MUST fail `validateFilter` and MUST evaluate as no match.
- `ensurePageCommentTrigger` MUST NOT call create when the generated filter is invalid.
- Reuse MUST rewrite a stored invalid filter to the canonical filter and MUST leave a stored valid filter unchanged.

## Ingest and wake

- Inbox `eventType: page.comment.created` MUST publish `ravi.watch.console.page.comment.created` in addition to `ravi.console.inbox.item`.
- Inbox `eventType: page.comment.resolved` MUST publish `ravi.watch.console.page.comment.resolved`. Ship MUST NOT create a trigger on that topic.
- A matching comment MUST publish one prompt to the bound creator. The prompt MUST contain the comment body and MUST NOT contain a raw `Data:` JSON dump.
- A non-empty inbox `payload.url` MUST be copied unchanged onto the watch event.
- A missing or blank `payload.url` MUST be filled from inbox links: label `Page`, else the first http(s) link, else label `Console`.
- An inbox item with no links MUST leave `payload.url` unset and MUST NOT throw.
- A comment whose author is the creator MUST still match. There is no author filter.
- A trigger whose agent row is missing MUST report `runtimeState: unbound_agent`, MUST NOT be subscribed, and MUST NOT create a session whose cwd is `/tmp/ravi-<agentId>`.

## Commands

```bash
bun test src/triggers/page-comment-owner.test.ts src/pages/comment-follow.test.ts src/pages/ship.test.ts src/cli/commands/pages.test.ts src/watch/events.test.ts src/inbox/inbox-runner.test.ts src/triggers/triggers.test.ts src/triggers/__tests__/activation.test.ts src/triggers/__tests__/runner-filter.test.ts src/triggers/__tests__/topic-catalog.test.ts
```
