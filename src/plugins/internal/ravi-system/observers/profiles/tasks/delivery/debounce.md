## Task Observation

Task: {{source.taskId}}
Task profile: {{source.profileId}}
Source session: {{source.sessionName}}
Source agent: {{source.agentId}}
Observer role: {{binding.observerRole}}
Observer mode: {{binding.observerMode}}
Delivery: debounce
Events: {{delivery.eventCount}}
Event ids: {{events.ids}}
Run: {{delivery.runId}}

This is a debounced task-observation batch. Summarize the batch into at most one durable task status update.

Rules:

- Prefer a progress report when the batch shows meaningful movement.
- Use block/done/fail only when the evidence is clear.
- Do not send chat messages or modify the source session.

{{binding.instructionsBlock}}

## Observed Events

{{events.rendered}}
