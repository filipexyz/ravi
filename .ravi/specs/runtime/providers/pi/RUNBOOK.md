# Pi Provider Runbook

## Preflight

1. Verify the Pi executable or package entrypoint is available.
2. Verify the target cwd exists and is the intended Ravi agent cwd.
3. Verify model/provider credentials are configured in Pi's agent dir or inherited env.
4. Verify the Ravi agent does not require restricted tool access in the RPC MVP.
5. Verify `RuntimeCapabilities` compatibility passes before starting the provider.

## Start A Session

1. Spawn Pi in RPC mode.
2. Attach a strict JSONL reader to stdout.
3. Capture stderr for logs only.
4. Send `get_state` after startup.
5. If resuming, validate `sessionFile` and cwd before `switch_session`.
6. Emit synthetic `thread.started` metadata from `get_state` when available.

## Run A Prompt

1. Wait for a Ravi `RuntimePromptMessage`.
2. If Pi is idle, send `prompt`.
3. If Pi is streaming, reject regular prompt delivery and require explicit `turn.steer` or queued follow-up semantics.
4. Convert Pi events to Ravi runtime events.
5. Emit exactly one terminal event for the accepted Ravi prompt.

## Handle Multiple Incoming Chat Messages

1. Keep Ravi agent/channel debounce behavior unchanged. Debounce happens before runtime dispatch.
2. After a Pi session handle exists, do not route interactive `after_tool` messages through Ravi `pendingMessages` when Pi native steer is available.
3. If the Pi turn is already active, call runtime control `turn.steer` immediately.
4. If the first Pi prompt has not been yielded yet but the handle exists, accept `turn.steer` into the Pi provider's pre-start steer buffer.
5. On Pi startup, send `set_steering_mode all` unless Pi already reports that mode.
6. Flush buffered pre-start steers after queue-mode configuration and before the first `prompt`.
7. Do not concatenate these steered messages in Ravi; Pi owns the queue drain semantics.

## Interrupt

1. Send Pi `abort`.
2. If Pi emits aborted stop reason, map it to `turn.interrupted`.
3. If the process exits after abort without a native terminal event, synthesize `turn.interrupted`.
4. Kill the subprocess if it does not exit inside the configured grace window.

## Debug A Stuck Turn

- Check whether Pi emitted `message_update`, `tool_execution_*`, `turn_end`, or `agent_end`.
- Check whether the adapter incorrectly treated Pi `turn_end` as Ravi terminal.
- Check whether a parallel tool batch left Ravi host state with one active stale tool.
- Check stderr for process-level failures.
- Check whether `get_state.isStreaming` disagrees with Ravi `turnActive`.
- If repeated human messages were merged into one assistant context unexpectedly, check for `dispatch.push_existing` after a Pi handle already exists. Interactive `after_tool` prompts should usually show `dispatch.native_steer` instead.
- If the issue happened immediately after cold start, check whether the second message arrived before the first `turn.started`. This is the pre-turn steer gap covered by the provider buffer.

## Rollout

1. Add capabilities and compatibility gates.
2. Add fake RPC transport tests.
3. Add Pi provider behind explicit provider id only.
4. Create one dev-only Ravi agent using provider `pi`.
5. Run a text-only prompt E2E.
6. Run a tool prompt E2E.
7. Run interrupt, model switch, and resume tests.
8. Only then make Pi selectable for normal task workers.
