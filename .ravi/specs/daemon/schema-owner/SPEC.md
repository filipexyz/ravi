---
id: daemon/schema-owner
title: Exclusive schema ownership
kind: capability
domain: daemon
capability: schema-owner
tags:
  - sqlite
  - migrations
  - restart
applies_to:
  - src/db/schema-lock.ts
  - src/db/daemon-schema-owner.ts
  - src/db/schema-owner.ts
  - src/cli/env.ts
  - src/cli/daemon-restart-supervision.ts
  - src/daemon.ts
owners:
  - dev
status: active
normative: true
---

# Exclusive schema ownership

## Invariants

- Production schema authority MUST remain restricted by the state boundary. Possessing a lock or writing a phase receipt MUST NOT grant authority to open production state.
- A daemon MUST acquire process-lifetime kernel ownership before command authorization, configuration reads, SQLite opens, migrations or NATS startup can touch its state.
- Ownership MUST cover the canonical state root and the physical paths of runtime stores, including an external credentials DB override. Two roots MUST NOT acquire independent ownership of the same overridden store.
- A standby process MAY be supervised by PM2, but MUST NOT access databases before acquiring ownership. A paused owner MUST NOT lose ownership through a timeout, heartbeat expiry or PID-based stale-file cleanup.
- Daemon ownership MUST remain held through shutdown and final database writes. Process exit releases it; the runtime MUST NOT release it early to allow a successor to boot.
- Every component initializer MUST serialize its complete inspect/invalidate/migrate/ready sequence under the database's kernel lock. Successful readiness MUST only be published after the callback completes; a failed callback MUST NOT publish readiness.
- This exclusion MUST NOT add a SQL transaction around migrations. Existing explicit transactions and foreign-key mode changes retain their semantics.
- Symlink aliases MUST share ownership. Hardlinked databases MUST be refused; a path sidecar cannot represent every hardlink alias safely.
- Lock sidecars MUST remain at stable paths/inodes. Neither normal release nor crash recovery may unlink them. Descriptors MUST be close-on-exec.
- PM2 `online` and a live PID MUST NOT mean service readiness. The restart supervisor MUST require a current phase receipt before stopping predecessors, and `ready` from the same process incarnation after cutover before reporting success.
- No schema rollback MUST be inferred from restart failure. Destructive migrations require their own tested recovery plan.

## Boundary

Kernel locks are cooperative coordination on local macOS/Linux filesystems, not protection against malicious code with the host account. All schema writers must adopt the protocol. Mixed-version boot with an older non-participating daemon is not a rolling upgrade: stop the legacy runtime and old channels before the first coordinated boot.

Channel consumers remain subject to exact-release readiness and the state boundary. This change does not provide online cross-release data-reader/writer compatibility, broker leader fencing, or a distributed lock for network filesystems.

## Acceptance

- Two live initializers cannot interleave a single DB's migration callbacks.
- A PM2-supervised successor waits without database activity until its predecessor exits.
- SIGSTOP preserves exclusion; SIGKILL permits recovery without deleting coordination files.
- Foreign-key children survive the credential-style table rebuild, and explicit BEGIN/COMMIT migrations run unchanged.
- A stalled, missing, or different-PID successor never produces a successful restart result.
