# Runtime Context Recovery Checks

## Unit Tests

- Classifier recognizes the Codex context-window error.
- Credential classifier maps the same message to `context_limit` with `scope=request`.
- Recovery prompt strips session surface headers, route hints, chat ids, and raw message ids.
- Recovery prompt is not JSON.
- Recovery prompt stays under the configured character budget.

## Event Loop Tests

- A context-window `turn.failed` records a terminal failed turn with `autoRecovered=true`.
- The event loop records `session.context_window_exhausted`.
- Provider state is cleared with `resetSession`.
- The current user-visible raw provider error is not emitted as a runtime response.
- A restart is requested with reason `runtime_context_window_exhausted`.
- The stashed restart prompt contains the latest user request and local recent history.

## Manual Validation

1. Force a Codex session near/exceeding its context window.
2. Confirm the provider emits `turn.failed` with context-window wording.
3. Run:

```bash
ravi sessions trace <session> --only runtime --since 10m
ravi sessions info <session>
```

4. Expected:
   - session trace has `session.context_window_exhausted`;
   - provider session id is cleared before the restart;
   - the next `adapter.request` uses `resume=false`;
   - the agent continues from the latest user request without asking the user to repeat.

## Provider Regression

- Claude/Pi generic failures still surface normally.
- Credential failures still use credential retry logic when retryable.
- Interrupted-tool recovery still stashes pending messages as before.
