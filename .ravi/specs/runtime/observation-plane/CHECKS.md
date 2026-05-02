# Observation Plane / CHECKS

## Checks

- Create one source session with no observers. It MUST run with no observation overhead beyond event emission.
- Create one source session with three observers. Each observer MUST receive only its selected events.
- Create one source session with thirty observers. The source session MUST complete without waiting for observer runs.
- Force one observer to fail. The source turn MUST still complete and the observer failure MUST be traceable.
- Deliver the same event batch twice. The observer MUST dedupe or produce idempotent side effects.
- Render an event batch through an observer profile. The observer-facing prompt MUST be readable Markdown and MUST NOT default to raw structured payload dumps.
- Render `message.user`, `turn.complete`, and `turn.failed` through different event templates. Each fragment MUST reflect the event-specific format.
- Create a task with profile `observed-task` and a profile-scoped observer rule using observer profile `tasks`. The worker prompt MUST omit direct `ravi tasks report|block|done|fail` responsibility, and the observer prompt MUST instruct the observer to own durable status sync.
- Verify observer sessions do not trigger observers by default.
- Verify observer sessions do not inherit source tools, loaded skills, context key, or channel outbound permissions.
- Verify task reporter observer can call `tasks.report` while the worker session cannot, when configured that way.
- Verify redaction prevents unrelated chat/contact/session metadata from leaking into observation payloads.
- Verify event replay can explain why a binding matched or did not match a source event.
