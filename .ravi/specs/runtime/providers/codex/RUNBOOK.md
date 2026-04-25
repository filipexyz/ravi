# Codex Provider Runbook

## Debug A Stuck Codex Turn

1. Inspect `adapter.request` for provider, model, cwd, prompt hash, and previous provider session id.
2. Inspect `provider.raw` events for `thread/started`, `turn/started`, and `turn/completed`.
3. If a tool started, verify there is a matching `tool.completed`.
4. If a dynamic tool ran, verify the JSON-RPC response had `success` and `content_items`.
5. If a reaction or silent turn happened, verify `turn.complete` was emitted even without assistant text.
6. If the native child exited, verify the provider emitted `turn.failed` or `turn.interrupted`.
7. If watchdog recovered the turn, treat it as an adapter/runtime bug until proven otherwise.

## Runtime Control

```bash
ravi sessions runtime list <session> --json
ravi sessions runtime read <session> --json
ravi sessions runtime steer <session> "..." --json
ravi sessions runtime interrupt <session> --json
ravi sessions runtime rollback <session> 1 --json
ravi sessions runtime fork <session> --json
```

## Dynamic Tool Debug

- Look for provider raw method `item/tool/call`.
- Confirm `buildRuntimeDynamicToolCallRequest` produced the expected tool name and call id.
- Confirm host services authorized `use tool:<name>`.
- Confirm response normalization returned at least one `inputText` or `inputImage` item.
- Confirm synthetic `tool.started` and `tool.completed` appear in trace.
