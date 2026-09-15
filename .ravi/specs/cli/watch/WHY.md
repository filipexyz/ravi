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

Inbox is the local attention and triage surface, not watch configuration.
Users should not need to know whether a watch runs locally or in Console to
create it or attach a trigger. Console delivery is implementation plumbing for
remote watch events.

## Why Brake `rm`, `trigger` And `run` (Agent-First Wave)

`rm` deletes local state and, for console watches, the remote provider watch —
there is no undo. `trigger` looks like a read helper but arms a durable
automation: every future watch event fires a prompt at an agent session, so a
misfired trigger keeps acting long after the mistake. `run` starts a real poll
cycle that can emit events and fire whatever triggers are already wired. Those
three got the dry-run + `--execute` brake; `create` stays immediate because it
is the domain's entry point with an obvious inverse, and `enable`/`disable`
are a reversible pair — braking them would only add exit-3 friction.

One wrapper subtlety found in this wave: `runWatchCommand` catches every error.
It now rethrows existing `ContractError` values, converts expected local
failures, preserves stable provider codes with allowlisted details, and maps
unknown failures to redacted `UNHANDLED_ERROR`; the 1/2/3 taxonomy therefore
survives the dispatcher without exposing raw provider text.
