# Task Reporting / WHY

Task progress cannot live only in chat text. The task runtime needs durable
progress, terminal state, checkpoint reminders, and optional report prompts even
when work happens through ordinary chat, observers, automations, or external
executors.

This capability keeps durable task state in the task runtime and separates
checkpoint reminders, observer synchronization, and report delivery.
