# Restart Context Preservation / RUNBOOK

## Debug Flow

1. Inspect the CLI audit event for `daemon.restart`.
2. Confirm whether `RAVI_CONTEXT_KEY` or inline runtime context existed.
3. Inspect the persisted restart reason metadata.
4. Confirm whether the child process rewrote the file.
5. Verify which session received the post-restart notice.

## Useful Signals

- Restart message
- Caller session name
- Caller session key
- Child process context availability
- Post-restart target session
