### Source Turn Interrupted

Event: {{event.id}}
Turn: {{event.turnId}}
Details: {{event.payloadSummary}}

Interpretation guide: interruption usually means no durable task-state mutation. Preserve idempotency and wait for the next complete batch unless the interruption itself reveals a concrete blocker.
