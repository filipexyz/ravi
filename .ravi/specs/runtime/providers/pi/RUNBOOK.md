# Pi Provider Runbook

## Preflight

1. Verify the Pi executable or package entrypoint is available.
2. Verify the target cwd exists and is the intended Ravi agent cwd.
3. Verify model/provider credentials are configured in Pi's agent dir or inherited env.
4. Verify `RuntimeCapabilities` compatibility passes before starting the provider. Restricted agents are allowed only when the permission extension is live (`tools.permissionMode=ravi-host`). Compatibility is a contract: the session MUST still prove the bridge with `ravi.permission.hooks.ready` before any prompt.
5. Verify the spawned Pi command includes `--extension` pointing at the materialized Ravi permission extension.

## Start A Session

1. Spawn Pi in RPC mode with the Ravi permission extension.
2. Attach a strict JSONL reader to stdout.
3. Capture stderr for logs only.
4. Send `get_state` after startup.
5. If resuming, validate `sessionFile` and cwd before `switch_session`.
6. Wait for `extension_ui_request` notify `ravi.permission.hooks.ready` before sending any `prompt`. If it never arrives, or a tool starts first, fail the turn (`failureKind=transport`) and do not run an ungoverned ravi-host session.
7. Emit synthetic `thread.started` metadata from `get_state` when available.
8. Answer `extension_ui_request` with title `ravi.permission.request` through Ravi host services. Cancel any other dialog. Do not wait for a command `response` on those writes.

## Run A Prompt

1. Wait for a Ravi `RuntimePromptMessage`.
2. If Pi is idle, send `prompt`.
3. If Pi is streaming, reject regular prompt delivery and require explicit `turn.steer` or queued follow-up semantics.
4. If Pi rejects the `prompt` with "already processing", retry the same plain `prompt` on the busy backoff (`100, 250, 500, 1000, 2000` ms). This handles the race where Pi's `isStreaming` lags the `agent_end` event Ravi already observed. Never substitute `streamingBehavior=followUp` here — Pi may have already drained its follow-up queue, which would orphan the message or reorder it behind the next prompt.
5. Convert Pi events to Ravi runtime events.
6. Emit exactly one terminal event for the accepted Ravi prompt.

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
3. Drain leftover queued RPC events so a stale `agent_end` cannot complete the next prompt.
4. Re-read `get_state`. If Pi still reports streaming/processing, send `abort` again and restart the RPC process before the next prompt.
5. If the process exits after abort without a native terminal event, synthesize `turn.interrupted`.
6. Kill the subprocess if it does not exit inside the configured grace window.

## Debug A Stuck Turn

- Check whether Pi emitted `message_update`, `tool_execution_*`, `turn_end`, or `agent_end`.
- Check whether the adapter incorrectly treated Pi `turn_end` as Ravi terminal.
- Check whether a parallel tool batch left Ravi host state with one active stale tool.
- Check whether Pi emitted `extension_ui_request` notify `ravi.permission.hooks.ready` after spawn. A missing handshake means `--extension` did not load; the adapter MUST fail closed instead of sending `prompt`.
- Check whether Pi emitted `extension_ui_request` and whether Ravi answered `extension_ui_response`. A hang on the first tool often means the host did not write the UI response.
- Check whether a restricted deny is coming from `canUseTool` or from Bash `authorizeCommandExecution` (unconditional blocks, observation, skill gate).
- Check stderr for process-level failures.
- Check whether `get_state.isStreaming` disagrees with Ravi `turnActive`.
- If channels saw the literal string "Agent is already processing", confirm the busy-retry backoff exhausted all 5 attempts (~3.85s). After that budget the adapter MUST restart the Pi process (when it can) and retry once. A still-busy `turn.failed` MUST carry `failureKind=transport` so the host respawns instead of reusing the stuck runtime. Inspect `provider.raw` for `compaction_start` without a matching `compaction_end`, and confirm the previous turn was not a leftover `agent_end` consumed as a ~60ms fake `turn.complete`.
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
