# Session Followups / WHY

Session followups are inactivity cadences, not cron jobs. The clock resets from
conversation activity, so a normal wall-clock schedule would either fire too
early or miss the operational intent.

This capability lets Ravi create durable, idempotent reminder runs for existing
sessions or attached chats without creating routes, duplicating prompts, or
blocking daemon startup when a cadence fails.
