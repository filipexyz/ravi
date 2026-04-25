# Pi Provider Checks

## Contract Tests

- Provider id is `pi`.
- Capability matrix includes generic extended fields before provider is enabled broadly.
- Restricted agents are rejected in RPC MVP.
- `startSession` starts a fake RPC client and returns a valid runtime handle.
- `interrupt()` sends `abort` and emits `turn.interrupted`.
- `setModel()` sends `set_model` and affects subsequent prompt metadata.
- Resume validates cwd and session file before using Pi state.
- Startup sends `set_steering_mode all` unless `get_state` already reports `steeringMode=all`.
- A `turn.steer` accepted before provider startup is buffered and flushed to Pi before the first `prompt`.
- Active-turn `turn.steer` sends Pi RPC `steer` and does not become Ravi host prompt concatenation.

## Event Mapping Tests

- `turn_start` maps to `turn.started`.
- `message_update:text_delta` maps to `text.delta`.
- `message_update:thinking_delta` does not leak hidden reasoning as assistant output.
- `message_end` for assistant text maps to `assistant.message`.
- `tool_execution_start` maps to `tool.started`.
- `tool_execution_end` maps to `tool.completed`.
- `compaction_start` maps to `status: compacting`.
- `turn_end` with aborted stop reason maps to `turn.interrupted`.
- `turn_end` with error stop reason maps to `turn.failed`.
- `agent_end` maps to `turn.complete` exactly once when no earlier terminal event exists.

## Negative Tests

- RPC process exits before terminal event.
- RPC stdout emits malformed JSON.
- RPC response for `prompt` fails before acceptance.
- Prompt is sent while Pi is streaming without explicit steer/follow-up.
- Interactive `after_tool` prompt reaches Ravi `pendingMessages` after a live Pi handle exists when native steer should have been used.
- Pi emits parallel tool starts before prior tool ends.
- Pi emits tool update forever without terminal event.
- Pi emits assistant message after interrupt.
- Session file exists but cwd does not match.
- Usage is missing on successful agent end.

## E2E Smoke

- Text-only prompt completes and saves provider session state.
- Cold-start burst: send two or more messages quickly; trace should show first `dispatch.cold_start`, then `dispatch.native_steer` for subsequent interactive messages once the Pi handle exists, without Ravi generator concatenating them into one pending prompt.
- Active-turn burst: send multiple messages while Pi is responding; trace should show repeated `dispatch.native_steer`, and Pi should process them through native steering rather than one Ravi-concatenated prompt.
- Tool-using prompt emits tool start/end and then completes.
- Interrupt during text streaming ends as interrupted, not failed.
- Model switch changes subsequent execution metadata.
- Restart/resume uses Pi session state only when cwd matches.
