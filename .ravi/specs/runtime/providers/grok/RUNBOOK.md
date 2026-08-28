# Grok Build Provider Runbook

## Preflight

1. Verify the `grok` executable is available, or set `RAVI_GROK_COMMAND`.
2. Verify the target cwd exists and is the intended Ravi agent cwd.
3. Verify Grok authentication: `grok login` or `XAI_API_KEY`.
4. Verify the Ravi agent does not require restricted tool access in the ACP MVP.
5. Verify `RuntimeCapabilities` compatibility passes before starting the provider.

## Start A Session

1. Spawn `grok --no-auto-update --no-alt-screen --always-approve agent stdio`.
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
5. When `session/prompt` returns, emit `assistant.message` if text arrived, then exactly one terminal event.

## Interrupt

1. Send ACP `session/cancel` for the current `sessionId`.
2. Auto-cancel any in-flight `session/request_permission` requests.
3. Expect `stopReason=cancelled` or a transport error, then emit `turn.interrupted` once.

## Resume

1. Read `RuntimeSessionState.params.sessionId`.
2. Reject resume when stored cwd does not match.
3. Call `session/load` only when initialize advertised `loadSession`.
4. Persist the same `sessionId` on the next `turn.complete`.

## Debug A Stuck Grok Turn

1. Inspect `adapter.request` for provider `grok`, model, cwd, and previous session id.
2. Inspect `provider.raw` events for `session/update` payloads.
3. If a tool started, verify there is a matching `tool.completed`.
4. If the native child exited, verify the provider emitted `turn.failed` or `turn.interrupted`.
5. If there is no terminal event, inspect ACP `session/prompt` completion and adapter terminality before touching host runtime.
