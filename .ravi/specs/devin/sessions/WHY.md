# Why Devin Sessions

Devin sessions are the primary unit of external work delegation. They represent
long-running code execution that Ravi creates, monitors, and brings back as
artifacts and task state.

## Key Decisions

- **Ravi owns provenance.** Each remote session is linked to local origin context
  (task, project, prox run, agent, session name) at creation time.
- **ID normalization to `devin-` prefix.** All stored and API-used IDs use the
  canonical prefixed form regardless of what the user or API response provides.
- **Dedicated SQLite DB.** Devin data lives in `devin.db`, not the main router DB,
  for clean domain isolation and independent schema evolution.
- **Explicit lifecycle.** Sessions are created, polled, messaged, synced, terminated,
  and archived through deliberate CLI actions. No automatic state transitions that
  spend money or impersonate users.
- **Sanitized audit trail.** Store records effective identity, mode, platform,
  ACU source, and secret references (never values) so operators can reconstruct
  who ran what, under which constraints.
