# Task Reporting Delivery / WHY

Task reporting delivery moves progress and terminal state from workers,
observers, or CLI callers into durable task state and, only when configured, to
a report target session.

The feature prevents chat-only completion, accidental report fan-out, and
profile-specific assumptions about `TASK.md`. Durable state belongs to the task
runtime; report prompts are a secondary explicit delivery path.
