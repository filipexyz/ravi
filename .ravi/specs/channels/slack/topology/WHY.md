# Why Slack Topology Exists

Slack has user-facing organization that looks like "sessions" in the sidebar, while Ravi has runtime sessions with a different meaning.

If agent output merges those concepts, operators cannot tell whether a channel is merely grouped in Slack or actually bound to a Ravi agent/session.

Topology gives agents one read-only source of truth:

- how Slack groups channels;
- which channels are visible to the bot;
- which Ravi route would handle each channel;
- whether a route points at a canonical session;
- which channels are ungrouped or unrouted.
