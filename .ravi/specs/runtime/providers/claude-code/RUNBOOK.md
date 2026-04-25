# Claude Code Provider Runbook

## Debug A Turn

1. Check `adapter.request` for resume/fork, model, hooks, plugin names, spec server, remote spawn, and prompt hashes.
2. Check `provider.raw` events for stream deltas, assistant blocks, user tool results, and final result.
3. If a tool starts but never ends, inspect whether a native tool-result event was emitted.
4. If a turn fails after interruption, verify whether the host classified it as recoverable interruption.
5. If a model switch happened, verify whether `setModel` was called and whether subsequent turns used the new model.
6. If spec mode failed open, inspect host hook attachment and spec server activation.

## Common Checks

- Session id should persist on `turn.complete`.
- Fork should only happen when parent provider state belongs to the same provider.
- Hooks should not be attached when capabilities say unsupported.
- Remote spawn should not be attached unless the agent has remote config.
- Spec server should not be attached unless the agent is in spec mode.
