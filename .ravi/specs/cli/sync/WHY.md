# Sync agent-first CLI contract / WHY

`sync push` and `sync pull` are the two commands in this domain that move data
in bulk across the trust boundary: push uploads a batch of local events to
Console, pull downloads a remote batch and APPLIES it to local state. Neither
is item-reversible from the CLI, both can be large, and pull literally mutates
the local install with remote content. That is why both got the brake while
`retry` — a local flip of failed/dead rows back to pending — stayed immediate:
retry writes nothing remote and its effect is consumed by the next (braked)
push anyway.

The dry-run plans deliberately include the local queue counters
(`outboxPending`, `inboxPending`, ...) from the cheap `getSyncStatusSummary()`
read: "what would this push move?" is the question the agent needs answered
before `--execute`, and the counters answer it without touching Console.

One ordering subtlety shaped the implementation: `push --traces` calls
`enqueueTraceExportBatch()` — a LOCAL write — before uploading. If the brake
fired after that call, a "dry-run" would still mutate the trace outbox. The
brake is therefore the first statement of the command, before the bridge is
even constructed.

`inspect` was the domain's silent-miss trap: unknown ids returned
`{found:false}` with exit 0, indistinguishable from success in an agent loop
that checks exit codes. It now fails with `SYNC_RECORD_NOT_FOUND` exit 1. Ids
are opaque ULIDs, so the envelope points at `sync status` instead of emitting
similarity noise.
