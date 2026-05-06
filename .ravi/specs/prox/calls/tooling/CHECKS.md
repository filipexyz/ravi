# Checks

## Static Checks

- Every provider-exposed tool has a `call_tool`.
- Every profile-exposed tool has a `call_tool_binding`.
- Every `bash` executor has fixed `cwd`, command, argv template, timeout, env allowlist, and output limits.
- No Bash executor uses freeform shell, `eval`, command separators, or unbounded output.
- Every tool declares side-effect class.
- Every external side-effect tool has explicit policy.

## Runtime Checks

- Invalid input schema blocks before executor invocation.
- Policy block creates `call_tool_run.status = blocked`.
- Timeout creates `call_tool_run.status = timed_out`.
- Non-zero Bash exit creates structured failed result.
- Tool start/completion/failure appears in `call_event`.
- Provider receives safe `message`, not raw stdout/stderr.
- Secrets are absent from events, logs, transcripts, and provider output.

## Regression Cases

- `call.end` is idempotent when called twice.
- `person.lookup` cannot return non-allowlisted private fields.
- `prox.note.create` persists internal note and returns safe confirmation.
- `prox.followup.schedule` respects quiet hours and call rules.
- `task.create` creates a task with origin lineage.
- An unbound tool call from provider is rejected and audited.
- A provider-specific alias routes through the same executor as `/webhooks/prox/calls/tools`.
