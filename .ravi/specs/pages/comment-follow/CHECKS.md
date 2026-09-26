# Page comment wake via triggers / CHECKS

## Ship binding

- `pages ship --execute` with a creator agent MUST create one trigger named `page-comment:<pageId>` on `ravi.watch.console.page.comment.created`, session `main`, cooldown 30s, bound to that agent.
- `<pageId>` MUST be the site id returned by publish. A slug-only site MUST NOT arm a trigger (`skipped: missing_page`).
- A second ship of the same page MUST reuse that trigger id and MUST keep the original `agentId`.
- Ship without an agent in context MUST return `commentFollow.skipped: missing_creator` and MUST NOT insert a trigger.
- Follow failure MUST NOT fail the ship that already published.

## Filters

- `pageCommentFilter` MUST pass `validateFilter`.
- The filter MUST match `payload.pageId`, root `pageId`, `payload.siteId`, and root `siteId` for the bound id, and MUST reject a different page id.
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
- A comment whose author is the creator MUST still match. v0 has no author filter.
- A trigger whose agent row is missing MUST report `runtimeState: unbound_agent`, MUST NOT be subscribed, and MUST NOT create a session whose cwd is `/tmp/ravi-<agentId>`.

## Commands

```bash
bun test src/pages/comment-follow.test.ts src/pages/ship.test.ts src/cli/commands/pages.test.ts src/watch/events.test.ts src/inbox/inbox-runner.test.ts src/triggers/triggers.test.ts src/triggers/__tests__/activation.test.ts src/triggers/__tests__/runner-filter.test.ts src/triggers/__tests__/topic-catalog.test.ts
```
