# Watch / CHECKS

## Static Checks

- Watch creation is exposed through `ravi watch`, not `ravi inbox`.
- Connector specs declare supported placements and event types.
- Watch event payloads do not include provider access tokens or raw private
  content.
- Console-produced watch events are delivered through Console delivery and
  republished as normalized `ravi.watch...` subjects.
- Trigger creation helpers create normal trigger records.

## Event Contract Regression

For each connector event, verify:

1. `eventId` is stable for retries;
2. `dedupeKey` identifies the provider event;
3. `subject` matches `ravi.watch.<connector>.<event-type>`;
4. `watchId`, `connector`, `placement`, and `eventType` are present;
5. event payload is enough for trigger filters.

## Trigger Regression

Create a watch-trigger pair from a group chat.

Expected:

- trigger topic points at the normalized watch subject;
- trigger reply source is the current chat;
- event fires the trigger once after cooldown/dedupe rules;
- disabling the trigger does not delete the watch.
