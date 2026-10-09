# Runtime Context Recovery / RUNBOOK

## Debug Flow

Use this runbook when a session failed with a context-window or missing
provider session error, restarted unexpectedly, or did not recover when it
should have. Recovery lives in `src/runtime/host-event-loop.ts` (the
`turn.failed` branch) and `src/runtime/context-window-recovery.ts`
(classifiers and prompt builder).

```bash
ravi sessions trace <session> --only runtime,session,adapter --since 30m
ravi sessions info <session>
ravi daemon logs -t 200
```

## Recognizing Which Recovery Ran

Both paths record a terminal `turn.failed` (group `runtime`) with
`autoRecovered=true`, then a `session`-group event with `status=recovering`:

| Cause | Classifier `matched` | Trace event | Restart / abort reason | Log line |
|-------|----------------------|-------------|------------------------|----------|
| Context window exhausted | `codex_context_window`, `context_window`, `prompt_too_long` (high); `context_length`, `context_limit`, `maximum_context`, `too_many_tokens`, `token_limit` (medium) | `session.context_window_exhausted` | `runtime_context_window_exhausted` | `Recovering runtime after context window exhaustion` |
| Claude stale session id (`No conversation found with session ID`) | `conversation_not_found` | `session.provider_session_missing` | `runtime_provider_session_missing` | `Recovering runtime after missing provider session` |

The `turn.failed` payload carries `recoveryKind`, `matched`, and `confidence`.
The `session.*` event payload adds `resetApplied`, `historyMessages`,
`recoveryPromptChars`, `recoveryMessageCount`, and `recoveryTruncated`.
Context-window classification wins when an error matches both.

A successful recovery then shows:

1. the next `adapter.request` with `resume=false`;
2. a prompt that starts with the plain-text recovery notice, the latest user
   request, and a compact recent transcript (bounded to 36 messages and
   12,000 characters by default);
3. `ravi sessions info <session>` showing `Runtime ID` as `(none)` until the
   new turn completes and writes the fresh provider session id back.

The user should not see the raw provider error as an assistant reply.

## When Recovery Was Skipped

If the error was classified but no restart happened, the failure surfaces as a
normal `turn.failed` (no `autoRecovered` / `recoveryKind` in the payload, no
`session.*` recovery event). What the chat shows depends on the turn: a
channel-backed turn gets the generic `safe_error` from the runtime channel
projection, while a classic chat turn gets `Error: <detail>`, the first line of
the provider error after `publicRuntimeFailureDetail`
(`src/runtime/public-failure.ts`) masks credential and account failures and
truncates long text. A classic turn gets no chat reply at all when the failure
is suppressed: sentinel agents, recoverable open-tool or interrupt failures
(`shouldEmitUserFacingTurnFailure`), and repeated runtime-limit failures. The
daemon log shows one of these warnings:

- `Skipping runtime session auto-recovery because the current turn is not replay-safe`:
  the failed turn had a started tool, materialized output, or a durable binding
  (see `startedTool`, `materializedOutput`, `durableBinding` in the log).
  Replaying could repeat side effects, so this is intended. Inspect the
  workspace and what the turn already did, then reset manually if the session
  must continue.
- `Skipping missing provider session recovery because no stored session id was resumed`:
  the session had no stored provider session id, so the provider failed on a
  fresh start. Clearing state again would loop. Treat it as a provider-side
  problem (Claude CLI storage, cwd, or credentials), not as stale state.

If neither warning appears and no `session.*` recovery event exists, the error
text did not match a classifier. Read `failureDetails` / `rawEvent` in
`ravi sessions trace <session> --only runtime --raw` and decide whether the
classifier in `context-window-recovery.ts` needs a new pattern (with a test).

If recovery ran but the agent looks confused, check the `session.*` event's
`historyMessages` and `recoveryTruncated`, then compare with durable history:

```bash
ravi sessions read <session> -n 40
```

## Manual Reset

When auto-recovery is skipped and the session must continue, reset provider
state by hand. This clears the provider session id, aborts the live runtime,
and revokes runtime contexts. It keeps the Ravi session row, messages, and
traces, but unlike auto-recovery it does not replay recent history, so the
next message starts from a blank provider conversation.

```bash
ravi sessions reset <session>            # dry-run, exit 3
ravi sessions reset <session> --execute
```

After the reset, send a message that restates the task, or point the agent at
`ravi sessions read <session>` so it can recover context itself.

## Do Not

- Do not delete the session (`ravi sessions delete`) to clear a stale provider
  id; reset is enough and keeps history.
- Do not edit `sdkSessionId` / `providerSessionId` in SQLite by hand while the
  daemon is running.
- Do not treat repeated `runtime_provider_session_missing` restarts as normal.
  One recovery per stale id is expected; a loop means the stored-id guard
  regressed.
