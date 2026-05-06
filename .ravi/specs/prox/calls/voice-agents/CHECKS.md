# Checks

## Static Checks

- Every call profile references a valid voice agent or declares an explicit migration exception.
- Every voice agent has provider semantics documented.
- Every provider id/pipeline id maps to one voice agent record.
- Every voice agent with tools uses `prox/calls/tooling`.
- Prompt/path/voice/tool changes bump version or create a snapshot.

## Runtime Checks

- `call_request` or `call_run` persists voice agent id/version.
- Provider config can be generated or validated from Ravi local state.
- Provider tool calls map back to effective voice-agent/profile tool bindings.
- Unknown provider agent ids are visible as config drift.

## Regression Cases

- Updating `ravi-interviewer` does not silently mutate `ravi-followup`.
- A call made before a prompt change still shows the old version/snapshot.
- Agora full-config uses local voice-agent config.
- Agora Studio pipeline records still map to local voice-agent records.
- A voice agent without permission cannot call `external_message` or irreversible tools.
