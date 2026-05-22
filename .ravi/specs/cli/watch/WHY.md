# Watch CLI / WHY

## Why Singular `watch`

The operator action is "watch this thing". A singular top-level command keeps
the workflow direct:

```bash
ravi watch create github filipelabs/ravi.bot
```

## Why Include Trigger Helpers

The main product goal is not just collecting events; it is making a group react
to useful events. A helper that creates a normal trigger from the current chat
keeps the common path short while preserving the existing trigger runtime.

## Why Not `inbox watch`

Inbox is implementation plumbing for Console-delivered events. Users should not
need to know whether a watch runs locally or in Console to create it or attach a
trigger.
