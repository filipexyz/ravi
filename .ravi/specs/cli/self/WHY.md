# Self agent-first CLI contract / WHY

`ravi self` is the orientation facade for agents and operators. It answers
which registered context is active, which actor/session/chat/route facts are
available, which capabilities are inherited, and which read should come next.
The answer must be useful without requiring callers to reconcile root help,
`self`, and `context` by hand.

Three decisions define the contract:

1. **Every operation is a pure read.** Context resolution uses `touch: false`
   and `readOnly: true`; no command accepts `--execute` or owns a write path.
2. **Uncertainty stays visible.** Absent sources remain
   `partial|missing|unavailable` with a reason. Environment-derived actor facts
   are marked `unverified`; they never silently become registry identity.
3. **Discovery is part of the facade.** Group help, JSON output, `explain`,
   return schemas and root operational help declare the same identity,
   environment, degradation and exit contracts.

`self context --fields` remains the compact entry point. It uses the shared
strict field selector, so unknown fields are `USAGE_ERROR` exit 2 with the
stable accepted field set rather than an empty success.

The domain intentionally has no skill. Its operational contract belongs in
the CLI surface itself; moving identity or environment rules into a separate
prompt asset would recreate the discovery drift this facade prevents.
