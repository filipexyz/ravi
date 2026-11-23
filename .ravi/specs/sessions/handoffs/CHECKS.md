# Session Handoffs Checks

- `src/handoffs/handoffs.test.ts`: policy (nothing before 15 min, one parent reminder, one owner notice at 45 min grouped by parent, closed handoffs ignored), supersede, explicit-reference acknowledgement, no claim on a failed delivery, owner text, event contract, and a guard that the core never names a channel.
- `src/cli/commands/sessions.test.ts` ("report --awaiting opens a handoff…"): `--awaiting` validation, `--ref` only with `--awaiting`, the report carries the handoff id, unrelated `thread-send` keeps it open, `thread-send` to the thread closes it.
- `src/channels/slack/thread-lifecycle.test.ts` ("reminds the parent of every open handoff…"): the Slack reminder is an internal `session.return` turn to the parent listing the open handoffs; a non-thread child is refused.
- `src/router/thread-identity.test.ts` ("session handoffs schema"): columns and the kind/status checks.
- `src/prompt-builder.test.ts` (Slack thread placement): the thread brief tells the thread to end a waiting report with `--awaiting <kind>` and `--ref`. The thread-return nudge (`src/channels/slack/thread-lifecycle.ts`) says the same.
