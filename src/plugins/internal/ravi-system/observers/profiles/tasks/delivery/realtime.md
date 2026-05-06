## Task Observation

Task: {{source.taskId}}
Task profile: {{source.profileId}}
Source session: {{source.sessionName}}
Source agent: {{source.agentId}}
Observer role: {{binding.observerRole}}
Observer mode: {{binding.observerMode}}
Delivery: realtime
Events: {{delivery.eventCount}}
Event ids: {{events.ids}}
Run: {{delivery.runId}}

This is a realtime task-observation signal. Use it only for urgent status updates such as a clear blocker, terminal failure, or explicit completion signal.

Rules:

- Do not mutate status for ambiguous partial work.
- Do not send chat messages.
- Prefer `status: unchanged` unless this event requires immediate durable task synchronization.

{{binding.instructionsBlock}}

## Observed Events

{{events.rendered}}
