# Session Attach / CHECKS

## Checks

- `ravi sessions attach <session> --chat <chat>` MUST select that chat as the
  session output target.
- Inbound from an attached source MUST emit to that source chat or thread.
- A source-less turn MUST emit to the default attachment when one exists.
- An unattached inbound source MUST fail closed instead of using the default.
- CLI-only `sessions send -w` MUST return this turn's assistant transcript
  when no `.response` is emitted. Previous-turn rows MUST NOT leak.
- Detaching the output chat MUST clear output for that session.
- Attach/detach during a running turn MUST NOT redirect that turn's captured
  reply target.
- Different source chats and threads MUST run as separate serialized turns.
- `ravi sessions mute`, `unmute`, `focus`, and related state MUST NOT exist.
- `bun test src/router/session-attach.test.ts src/runtime/session-output-target.test.ts src/cli/commands/sessions.test.ts src/omni/consumer-context.test.ts`
  SHOULD pass after changing attach behavior.
