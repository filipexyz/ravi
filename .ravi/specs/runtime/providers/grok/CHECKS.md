# Grok Build Provider Checks

## Contract Tests

- Provider id is `grok`.
- Capability matrix includes every required structured field.
- Restricted agents are accepted because `tools.permissionMode` is `ravi-host`.
- A session without a given tool grant cannot use that tool (spawn deny + ACP reject).
- A session with a narrow grant can use only those tools (spawn allow + ACP allow).
- `startSession` starts a fake ACP client and returns a valid runtime handle.
- `interrupt()` sends `session/cancel` and emits `turn.interrupted`.
- Resume uses `session/load` with the stored ACP `sessionId` and matching cwd.
- Spawn args include `agent stdio`, `--no-auto-update`, `--no-alt-screen`, `--permission-mode default`, and Ravi-derived `--allow` / `--deny`. They MUST NOT include `--always-approve`.
- Command override reads `RAVI_GROK_COMMAND`.
- `xhigh|max|ultra` map to native `--effort high`.
- `prepareSession` wires `approveRuntimeRequest` from Ravi host services.

## Event Mapping Tests

- Handshake `sessionId` maps to `thread.started`.
- Accepted prompt maps to `turn.started`.
- `agent_message_chunk` maps to `text.delta`.
- Accumulated assistant chunks map to `assistant.message`.
- `agent_thought_chunk` does not leak hidden reasoning as assistant output.
- `tool_call` maps to `tool.started`.
- `tool_call_update` completed/failed maps to `tool.completed`.
- `session/prompt` `end_turn` maps to `turn.complete` exactly once.
- `session/prompt` `cancelled` maps to `turn.interrupted`.
- `session/prompt` rejection maps to `turn.failed`.

## Negative Tests

- ACP process exits before terminal event.
- ACP stdout emits malformed JSON.
- ACP `session/prompt` fails before acceptance.
- Thought-only turn still emits exactly one terminal event.
- Resume is requested but the agent does not advertise `loadSession`.
- Incoming ACP methods other than `session/request_permission` are rejected.

## E2E Smoke

- Text-only prompt completes and saves provider session state. Manual only; not CI.
- Tool-using prompt emits tool start/end and then completes. Manual only; not CI.
- Interrupt during text streaming ends as interrupted, not failed. Manual only; not CI.
- Restart/resume uses Grok session state only when cwd matches. Manual only; not CI.
