# NATS Role Credentials / WHY

## Rationale

The local nats-server ran with no authentication. Any process able to open 127.0.0.1:4222 could publish `ravi.inbound.interaction` (approval of full access, decision answers from a card) or `ravi.inbound.command` with any sender, which bypasses every permission rule above the bus. Found in the security review of #1040 (27/11/2026).

## Why roles and not one password

One shared password protects only against programs that do not have it; every Ravi process would still be able to forge input. Roles let the server refuse channel input from the CLI and from turns.

## Why two phases

Daemon and channels runner can run different versions during an update (#904). Locking in the same release as the credentials would cut a runner that does not yet send one. The open phase accepts both and lets the operator confirm everyone authenticates before locking.

## Why the role is not an environment variable

Turns, cron shell and apps inherit the daemon's environment. A role read from the environment would hand them the daemon's credential.
