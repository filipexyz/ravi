# Watch / CHECKS

## Static Checks

- Watch creation is exposed through `ravi watch`, not `ravi inbox`.
- Connector specs declare supported placements and event types.
- Watch event payloads do not include provider access tokens or raw private
  content.
- Console-produced watch events are delivered through Console delivery and
  republished as normalized `ravi.watch...` subjects.
- Trigger creation helpers create normal trigger records.
- Examples that intend to create a trigger or run a poll cycle MUST include
  `--execute`; dry-runs MUST exit `3` without creating or starting either.

## Event Contract Regression

For each connector event, verify:

1. `eventId` is stable for retries;
2. `dedupeKey` identifies the provider event;
3. `subject` matches `ravi.watch.<connector>.<event-type>`;
4. `watchId`, `connector`, `placement`, and `eventType` are present;
5. event payload is enough for trigger filters.

## Watch Identity Regression

Local watch ids are deterministic (`provider` + `resourceRef` + `eventTypes`).
Recreating a watch that was deleted earlier MUST revive the soft-deleted row
instead of inserting a new one:

1. create → delete → create with the same event types succeeds and yields one
   visible watch, not `UNIQUE constraint failed: watches.id`;
2. the revived watch is `active` (never inherits the `deleted` status) and has
   `deletedAt` null;
3. lifecycle fields (`lastEventAt`, `lastDeliveryAt`, `lastErrorCode`) and the
   local poller snapshot from the previous cycle do not carry over.

## Comment Coverage

A local watch subscribed to `pull_request_comment.created`:

1. publishes one event per new comment on an open PR, with `repository`,
   `number`, `pull_request.number`, `commentId`, `url`, `author` and `body`;
2. does not publish twice for the same comment id, including after an edit;
3. keeps the comment state when a tick fails to read comments instead of treating
   the next read as all-new;
4. does not spend the two extra `gh api` calls when the watch does not subscribe
   to comments;
5. treats a snapshot written before comment reading existed as baseline.

## Follow Coverage

A PR follow owns its event producer, not just its trigger:

1. `ensureRepoWatch` reuses a local watch only when it covers the current derived
   set, and replaces its own outdated watch when the set grew;
2. it never removes a local watch without the ownership mark;
3. the maintenance sweep ensures a watch for every repo that still has a live
   follow, so a follow whose watch was deleted heals without a new `gh pr create`;
4. a failure while ensuring watches is logged and counted, and never deletes the
   follow trigger.

## Trigger Regression

Create a watch-trigger pair from a group chat.

Expected:

- trigger topic points at the normalized watch subject;
- trigger reply source is the current chat;
- event fires the trigger once after cooldown/dedupe rules;
- disabling the trigger does not delete the watch.
