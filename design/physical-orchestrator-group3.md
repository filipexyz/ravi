## Physical Orchestrator Group 3

Group 3 binds persisted session adapters into the Ravi session runtime through the new `session-adapter-bus`.

### What is wired

- Persisted adapters are loaded from SQLite on daemon startup.
- Adapters persisted as `running` are rebound and their STDIO supervisor is started again.
- The supervisor receives Ravi session identity in env:
  - `RAVI_CONTEXT_KEY`
  - `RAVI_SESSION_KEY`
  - `RAVI_SESSION_NAME`
  - `RAVI_AGENT_ID`
- Adapter stdout events and command lifecycle messages are published back into Ravi internal topics with session context attached.

### Topics

- `to-adapter`
  - If explicit subscriptions exist in `session_adapter_subscriptions`, those topics are used.
  - Otherwise the default topic is `ravi.session.{sessionName}.adapter.command`.
- `from-adapter`
  - If explicit subscriptions exist in `session_adapter_subscriptions`, those topics are used.
  - Otherwise the default topic is `ravi.session.{sessionName}.adapter.event`.

### Command payload

Publish JSON to a `to-adapter` topic in this shape:

```json
{
  "command": "ping",
  "args": ["alpha"],
  "payload": { "source": "session" }
}
```

The bus forwards this to the STDIO supervisor and republishes:

- `adapter.event`
- `command.ack`
- `command.result`
- `command.error`
- `protocol.error`
- `state`

### Restart behavior

`sessionAdapterBus.stop()` preserves persisted `running` state during daemon shutdown so the next daemon start can perform the minimum rebind automatically.
