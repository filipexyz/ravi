---
id: channels/runner
title: "Channel Runner"
kind: capability
domain: channels
capabilities:
  - runner
  - lifecycle
tags:
  - process
  - pm2
status: active
normative: true
---

# Channel Runner

## Responsabilidade

`ravi channels` MUST own native channel adapters, platform sockets/webhooks, outbound delivery, media and presence lifecycle.

`ravi daemon` MUST own sessions, agents and runtime. It MUST NOT open Slack Socket Mode connections or resolve Slack transport credentials.

## Outbound

User-visible native channel delivery MUST cross `CHANNEL_OUTBOUND` before adapter delivery.

The stream MUST be durable enough to survive a temporary `ravi channels` restart.

## Lifecycle

The runner MUST expose:

- `ravi channels start`
- `ravi channels stop`
- `ravi channels restart`
- `ravi channels status`
- `ravi channels logs`
- `ravi channels run`
- `ravi channels probe`

## Adapter Health

The runner MUST derive each adapter's live status from the adapter lifecycle,
not from process existence or from having invoked `start()` successfully.

For each configured Slack account, runner status MUST:

- remain starting/connecting until the active Socket Mode connection is
  actually healthy;
- transition through connected and reconnecting as the socket heartbeat and
  recovery loop changes state;
- retain non-secret transition reasons and lifecycle/health timestamps;
- recover independently from the state of other Slack accounts; and
- transition to disconnected during explicit runner shutdown without allowing
  retired adapter callbacks to restore an online state.

A PM2 process reported as online MUST NOT, by itself, be treated as proof that a
Slack adapter is connected.

Live status MUST scope its health request to the PM2 runner PID. If that PID
changes while the request is in flight, status MUST refresh the PM2 snapshot
and retry once against the replacement process instead of reporting the stale
PID as current.

## Locks

Adapters SHOULD use process or credential-scoped locks before opening external sockets. Slack MUST prevent duplicate Socket Mode consumers for the same connection.

## Process identity and freshness

- Daemon and runner status MUST expose `runningVersion`, `diskVersion`,
  `startedAt`, `stale`, `codeStale`, `envStale` and `identityVerified`.
- `runningVersion` MUST come from an immutable boot observation matched to
  the current PID and PM2 `pm_uptime`; it MUST NOT be read from the installed
  package at status time. Legacy or unverifiable processes MUST report null.
- PM2 `created_at` is registration age, not process start; status MUST use
  `pm_uptime`, including after automatic restarts.
- A changed bundle hash or bundle mtime newer than process start MUST mark
  code stale even when the path and version string are unchanged.
- An env file modified after process start MUST mark env stale. Only file
  metadata MAY enter status; secret values MUST NOT enter receipts or warnings.
- Runner bootstrap MUST load managed `.env` values over inherited process
  values, so an explicit restart actually adopts the file it certifies.
- `runtime.alignment` MUST include CLI, daemon and managed channel runner.
  Known staleness MUST prevent aligned; missing boot identity MUST remain
  unknown. A daemon-only installation need not invent a missing runner.
- Status and package/env mutations MUST name each stale process and its
  explicit restart command. Staleness detection MUST NOT restart any process.
  The only restart a runner initiates is the refusal relaunch below.
- Existing legacy state MUST be visible as unknown until an explicit restart
  writes a verifiable receipt; adding a guard for new starts alone is insufficient.

## Release drift after a daemon restart

State is prepared for one exact release (`state_schema_versions`), and a runner
never migrates it. When the installed daemon moves to a newer release, a runner
still executing the previous bundle is refused by that guard on every call that
re-checks it (`STATE_SCHEMA_NOT_READY`) while its sockets stay connected and PM2
still reports it online. The runner MUST NOT stay in that state:

- A runner MUST count consecutive `STATE_SCHEMA_NOT_READY` refusals of its
  outbound publish reconcile loop. A pass that clears the guard, and a failure
  for another reason (it proves nothing about the guard), MUST reset the count;
  only the pass also clears the refusal the runner reports in its health.
- After 3 consecutive refusals, and only when the installed bundle (read from
  disk at decision time) is a different release from the one the process is
  running, the runner MUST drain, exit with status 75 and let its supervisor
  relaunch it onto the installed release. A failed or slow drain MUST NOT keep
  a refused runner alive: exit is forced after a bounded wait.
- A refusal while the installed release equals the running release (the daemon
  has not prepared state yet) and an unreadable installed release MUST NOT
  restart the runner: restarting could not help, and staleness alone never
  restarts a runner.
- The relaunch MUST happen at most once per process: after it the releases match,
  so it cannot loop.
- Only non-`STATE_SCHEMA_NOT_READY` failures and stale-but-accepted runners keep
  the explicit-restart behaviour above.

## Release drift is visible where operators look

The relaunch only helps a runner that already runs this code, and only when a
restart can help. The same condition MUST also be visible without reading the
runner's log:

- `ravi channels status` MUST report health `degraded` with reason
  `release_drift` when the runner and the daemon booted with different releases,
  comparing the `runningVersion` of their boot receipts, and MUST put both
  releases, why it matters and the restart command in `warnings`. A release that
  cannot be verified (no receipt for the PID and start time yet) MUST be treated
  as unknown, never as drift.
- A runner whose state guard refuses its reconcile passes MUST report that in its
  health snapshot as a `degraded` entry of `adapters` with id
  `runner:release-guard` and reason `state_refused`, from the first refused pass
  until the first accepted one. `ravi channels status` MUST report health
  `degraded` with reason `state_refused` for it, whether the releases match or
  not. The snapshot MUST NOT gain a field for it.
- `ravi doctor` MUST report `channels.runner_release`: `fail` when the releases
  differ, `warn` when only the runner reports a refused guard (evidence on its
  own, whatever the releases are), `skip` otherwise when a release cannot be
  verified or a process is not online. The runner's own report
  comes from a bounded NATS probe; a runner that does not answer MUST NOT hold
  the doctor.
- Process liveness, stale code on its own and a connected socket MUST NOT turn
  this verdict on or off: they stay reported as `stale`, `codeStale` and adapter
  status.
