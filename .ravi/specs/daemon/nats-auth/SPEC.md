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
- Phase `open`: every role may do everything and connections without a user enter as `legacy`. Phase `locked`: `cli` and `omni` MUST NOT publish `ravi.inbound.>`, MUST NOT read it (an explicit subscription is refused and a wildcard does not deliver it), and MUST NOT administer JetStream streams (`$JS.API.STREAM.CREATE/UPDATE/DELETE/PURGE/RESTORE/SNAPSHOT/MSG.DELETE/TEMPLATE`), because the server republishes stream contents to any subject without checking the client's publish permissions. Connections without a valid user MUST be refused.
- Only the daemon and the channels runner create or change streams (audit, session prompts, channel outbound, leader KV). `cli` keeps reading stream info and managing its own consumers.
- The lock MUST come in a later release than the credentials, after daemon, channels and Omni are seen connecting with a credential, so a daemon and a channels runner on different versions keep working.

## Known Limit

Every Ravi process runs as the same OS user, and the credential files are readable by that user. What is covered:

- Other OS users on the host and programs that are not Ravi: covered (files are 0600 under the Ravi user).
- A Claude turn held below its agent (its shell restricted by the hook): covered, because the hook does not let it run a NATS client or read the files.
- A Codex turn held in the sandbox with the network closed: covered only while the network stays closed. The read-only sandbox reads the whole disk, so it can read `daemon.json`/`channels.json`; if it could also reach 127.0.0.1:4222 it could act as those roles.
- A turn with an unrestricted shell (full-access agent, owner turn): not covered; it is operator-equivalent by design.

## Validation

- `bun test src/nats-auth.test.ts`
