# Session Attach / CHECKS

## Checks

- `ravi sessions attach <session> --chat <chat>` MUST select that chat as the
  session output target.
- Inbound from a speak-enabled source subscription MUST emit to that source
  chat.
- Inbound from a muted subscribed chat MUST emit to the default speak attachment
  when one exists.
- Muting the current output attachment MUST clear the output marker.
- Detaching the output chat MUST clear output for that session.
- With no speak-enabled source and no speak-enabled output attachment, runtime
  MUST NOT emit externally.
- `ravi sessions focus` and related focus surfaces MUST NOT exist.
- `bun test src/router/session-attach.test.ts src/runtime/session-output-target.test.ts src/cli/commands/sessions.test.ts src/omni/consumer-context.test.ts`
  SHOULD pass after changing attach behavior.
