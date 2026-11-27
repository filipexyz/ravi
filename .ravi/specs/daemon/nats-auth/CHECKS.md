# NATS Role Credentials / CHECKS

## Checks

- `bun test src/nats-auth.test.ts` MUST pass. Against a real `nats-server` (skipped with a warning when the binary is absent; `NATS_SERVER_BIN` points to one), it checks that, once locked, `cli` cannot publish `ravi.inbound.interaction` or `ravi.inbound.command`, `channels` can, `cli` can still publish other subjects, a connection without a password or with a wrong one is refused, the open phase still admits an old client without a password, and `connectNats` with a declared role enters the locked server while a call with no credential on disk is refused.
- Unit checks: no credential means connecting as before; one 0600 credential per role, kept on rewrite; a credential readable by others or malformed throws; `cli` and `omni` lose `ravi.inbound.>` only when locked; `no_auth_user` only in the open phase.
