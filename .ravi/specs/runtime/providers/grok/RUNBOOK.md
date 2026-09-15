# Grok Build Provider Runbook

## Preflight

1. Verify the `grok` executable is available, or set `RAVI_GROK_COMMAND`.
2. Verify the target cwd exists and is the intended Ravi agent cwd.
3. Verify Grok authentication: `grok login` or `XAI_API_KEY`.
4. Verify the Ravi agent has the intended least-privilege grants. Restricted tool access is supported; full-access is not required.
5. Verify `RuntimeCapabilities` compatibility passes before starting the provider.

## Start A Session

1. Spawn `grok --no-auto-update --no-alt-screen --permission-mode default` plus `--tools` internal IDs, `--deny` ungranted classes, `--disallowed-tools` for the rest, and `--no-subagents` unless Agent is granted, then `agent stdio`. Do not pass `--always-approve` or class-wide `--allow Bash` / `--allow Read`.
2. Attach a strict JSONL reader to stdout.
3. Capture stderr for logs only.
4. Send `initialize`, then `authenticate` when auth methods are advertised.
5. If resuming, validate cwd and call `session/load`. Otherwise call `session/new`.
6. Emit `thread.started` from the ACP `sessionId`.

## Run A Prompt

1. Wait for a Ravi `RuntimePromptMessage`.
2. Emit `turn.started`.
3. Send `session/prompt` with a single text block.
4. Convert `session/update` notifications to Ravi runtime events while the prompt request is in flight.
5. When `session/prompt` returns, flush any remaining assistant text, then apply the tools-continuation gate before a terminal:
   - Open tools (`tool.started` without a matching terminal) -> recoverable `turn.failed`. Do not send a second prompt.
   - Tools finished and there is no post-tool assistant text -> one continuation `session/prompt`, then `turn.failed` if the model still does not reply.
   - Tools finished and the model replied, or the turn issued no tools -> `turn.complete`.
6. `handle_prompt.done ok=true` / `stopReason=cancelled` after tools is not user-visible success by itself.

## Interrupt

1. Send ACP `session/cancel` for the current `sessionId`.
2. Cancel any in-flight `session/request_permission` requests. Live requests that are not cancelled MUST be authorized by Ravi host services before selecting allow or reject.
3. Expect `stopReason=cancelled` or a transport error, then emit `turn.interrupted` once when the host locally aborted and the prompt did not complete `ok`.
4. If Grok still returns `ok=true` after tools, do not interrupt — continue or fail visibly.

## Resume

1. Read `RuntimeSessionState.params.sessionId`.
2. Reject resume when stored cwd does not match.
3. Call `session/load` only when initialize advertised `loadSession`.
4. Persist the same `sessionId` on the next `turn.complete`.

## Debug A Stuck Grok Turn

1. Inspect `adapter.request` for provider `grok`, model, cwd, and previous session id.
2. Inspect `provider.raw` events for `session/update` payloads.
3. If a tool started, verify there is a matching `tool.completed`. Host `tool.completed` without a Grok `exec_done` means ACP closed the prompt and synthesized a terminal — treat that tool as unfinished if no later model step exists.
4. If the native child exited, verify the provider emitted `turn.failed` or `turn.interrupted`.
5. If `session/prompt` settled after tools with no post-tool assistant text, the adapter must continue once or emit `turn.failed`. A silent `turn.complete` is a regression.
6. If there is no terminal event, inspect ACP `session/prompt` completion and adapter terminality before touching host runtime.
