# Task decision projection

A task has work status and may also wait for a decision. Parked stays derived so these facts coexist. Question storage is now independent because threads can wait without a task. The earlier decision to bind every question to a task is superseded; no artificial task is created for a thread.

Task events remain the consumer adapter for existing automations. Owner labels still do not establish authenticated approval, and observers do not invent answers.
