# Session Attach / CHECKS

## Checks

- `ravi sessions attach <session> --chat <chat>` MUST select that chat as the
  session output target.
- Inbound from an attached source MUST emit to that source chat or thread.
- A source-less cron/heartbeat/follow-up turn MUST emit to the default
  attachment when one exists.
- Operator / HTTP / app `sessions.send` without `--channel`/`--to` MUST NOT
  emit to leftover `lastChannel`/`lastTo` or the default output attachment.
  Chat emit MUST fail closed. `sessions.read` / `getRecentHistory` MUST
  still contain this turn's assistant row.
- An unattached inbound source MUST fail closed instead of using the default.
- CLI-only `sessions send -w` MUST return this turn's assistant transcript
  when no `.response` is emitted. Previous-turn rows MUST NOT leak.
- Operator CLI-only and HTTP/user `sessions.send` MUST persist the raw user
  text. The persisted `user.text` MUST NOT contain `[session surface]`,
  `waiting CLI`, or `no inbound chat`.
- The provider/runtime prompt for those operator turns MUST still include
  the `[session surface]` header (CLI-wait or no-inbound-chat) as
  launch-prompt metadata, not as the displayed user row.
- Inbound WhatsApp/Slack attach turns MUST still receive the
  `[session surface]` instruction on the runtime prompt and MAY keep it on
  the persisted user prompt.
- `sessions.send` input MUST NOT grow a `from` field. `[from:]` remains
  only `callerSessionKey` inside `[System] Inform:`.
- Detaching the output chat MUST clear output for that session.
- Detach MUST remain detached after repeated database initialization. A
  leftover `session_chat_bindings` row MUST NOT resurrect the subscription
  or fail the unique output-per-session index.
- Repeated detach MUST be idempotent and MUST preserve unrelated chats and
  session history.
- Inbound routing MUST attach through `session_chat_subscriptions` only.
- `ravi sessions attach|detach --json` MUST report attached, default output,
  remaining active subscriptions, and `legacy.status: none`.
- Attach/detach during a running turn MUST NOT redirect that turn's captured
  reply target.
- Different source chats and threads MUST run as separate serialized turns.
- `ravi sessions mute`, `unmute`, `focus`, and related state MUST NOT exist.
- `bun test src/router/session-attach.test.ts src/runtime/session-output-target.test.ts src/cli/commands/sessions.test.ts src/omni/consumer-context.test.ts src/runtime/session-surface-hint.test.ts src/runtime/session-trace.test.ts src/cli/session-cli-surface.test.ts`
  SHOULD pass after changing attach behavior.
