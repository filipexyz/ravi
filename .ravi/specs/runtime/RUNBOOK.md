# Runtime Runbook

## Mapping A Runtime Bug

1. Confirm the prompt reached the session stream.
2. Check dispatcher trace rows for debounce, queue, interrupt, restart, cold start, after-task deferral, or concurrency.
3. Check whether `adapter.request` exists for the turn.
4. If no `adapter.request` exists, debug dispatcher/launcher/request-builder.
5. If `adapter.request` exists, debug provider adapter and canonical events.
6. Check whether the turn has a terminal event: `turn.complete`, `turn.failed`, or `turn.interrupted`.
7. If no terminal event exists, inspect tool lifecycle, raw provider events, and watchdog recovery.
8. If terminal event exists but the UI/channel is wrong, debug event loop, gateway, or delivery.

## Useful CLI

```bash
ravi sessions trace <session> --explain
ravi sessions trace <session> --only runtime
ravi sessions trace <session> --only tools
ravi sessions trace <session> --turn <turn_id> --raw
ravi sessions runtime interrupt <session> --json
ravi events stream --only runtime
```

## Provider Integration Checklist

1. Add provider-local adapter files.
2. Register provider through the runtime provider registry.
3. Declare capability matrix.
4. Normalize native events into `RuntimeEvent`.
5. Ensure every provider prompt has a terminal event.
6. Wire Ravi permission/tool path through host services or host hooks.
7. Persist provider session state through `turn.complete`.
8. Add provider contract and event normalization tests.
9. Add focused runtime trace coverage for terminal state and tool lifecycle.

## Debugging Stuck Turns

- `adapter.request` without terminal turn means the provider handoff happened but Ravi did not receive a canonical terminal event.
- `tool.start` without `tool.end` means the adapter or provider lost tool completion.
- `tool.end failed` followed by no terminal event points to provider recovery/normalization issues.
- `session.stalled` means Ravi recovered by watchdog and did not trust the provider to finish.
- Repeated `dispatch.queued_busy` can mean the generator is waiting on terminal completion or a delivery barrier.
