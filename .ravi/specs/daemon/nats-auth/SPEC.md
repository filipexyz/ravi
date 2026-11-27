---
id: daemon/nats-auth
title: NATS Role Credentials
kind: capability
domain: daemon
capabilities:
  - nats-auth
tags:
  - security
  - nats
applies_to:
  - src/nats-auth.ts
  - src/nats.ts
  - src/daemon.ts
  - src/channels/runner.ts
  - src/threads/fence-adoption-live.ts
owners:
  - dev
status: active
normative: true
---

# NATS Role Credentials

## Intent

Only a channel runner (or the daemon) may publish channel input (`ravi.inbound.>`): it carries a sender the daemon trusts as verified. A process without that role, or a program that is not Ravi, must not be able to forge it on the local bus.

## Invariants

- Every Ravi connection to NATS MUST use the credential of its role when the host has one: `daemon` for `ravi daemon run`, `channels` for `ravi channels run`, `cli` for everything else.
- The role MUST be passed in code by the daemon and the channels runner, never read from the environment, so children (turns, cron shell, apps) stay `cli`.
- Credentials live in `<state>/nats/<role>.json` with mode 0600. A credential file that others can read, or that is malformed, MUST fail the connection with an error naming the file, never be skipped.
- A host with no credential files MUST connect exactly as before (no user).
- Rewriting the configuration MUST keep existing credentials, so live connections are not cut.
- Phase `open`: every role may do everything and connections without a user enter as `legacy`. Phase `locked`: `cli` and `omni` MUST NOT publish `ravi.inbound.>`, and connections without a valid user MUST be refused.
- The lock MUST come in a later release than the credentials, after daemon, channels and Omni are seen connecting with a credential, so a daemon and a channels runner on different versions keep working.

## Known Limit

Every Ravi process runs as the same OS user. A turn with an unrestricted shell can read the credential files, as it can read the state database: it is operator-equivalent by design. This protects against other OS users, other local programs and restricted turns.

## Validation

- `bun test src/nats-auth.test.ts`
