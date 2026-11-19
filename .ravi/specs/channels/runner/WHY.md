# Why Channel Runner

The channel runner exists so channel infrastructure can restart independently from the Ravi runtime daemon.

Hermes has a useful operational pattern here: a standalone gateway process owns platform adapters, connection lifecycle, platform locks, reconnects and delivery mechanics. Ravi should adopt that process separation, but not the Hermes ownership model where the gateway can become the agent runtime.

For Ravi, the boundary is stricter:

- channel runner owns transport and rendering;
- runtime daemon owns sessions and agents;
- broker owns credential release;
- durable delivery owns the handoff between runtime output and platform send.

This separation avoids three failure classes:

- restarting Slack Socket Mode should not restart all agents;
- a channel token should not be loaded by the runtime daemon;
- a channel runner outage should not silently drop a response already produced by a session.

The first implementation can be one channel runner process hosting Slack. The long-term design still needs instance-level locks so a future process-per-instance model does not change semantics.


## Installed files are not running code

Replacing a package in place leaves the existing daemon or runner executing
its previously loaded bundle and environment. Reading package.json through
its unchanged path can therefore falsely label an old process as aligned.
A boot observation plus current file evidence separates these facts.
Unknown legacy identity is explicit because the loaded version cannot be
reconstructed reliably after the original bundle has been overwritten.

Restart is an operator decision: detecting stale code must not unexpectedly
interrupt channel intake. Independent restart commands report any sibling
left behind instead of silently treating a successful restart as alignment.

## A refused runner relaunches itself

Prepared state is keyed to one exact release and a runner never migrates it.
After `bun add -g` and a daemon-only restart, the runner keeps executing the
previous bundle, is refused by the state guard on every pass that re-checks it,
and still looks healthy: PM2 reports it online and its Slack socket stays
connected. Status already names the drift and the explicit restart command, but
only in the log of the restart handoff, which nobody reads while the symptom is
happening (observed on 2026-11-19, daemon on 3.261119.9 and runner on
3.261119.6).

The tension with "restart is an operator decision" is resolved by what triggers
the restart. Stale code alone is accepted and reported: the runner is still doing
its job. A runner the state guard refuses repeatedly, while the installed bundle
is a different release, is not doing its job and cannot recover by waiting:
restarting is the only transition that ends the refusals, and it is the restart
the operator would have been told to run. A refusal with matching releases is a
daemon that has not prepared state yet, so a restart could not help and the
runner stays up. After one relaunch the releases match, so it cannot loop.

The exit is forced after a bounded wait because the drain proof latches every
refused pass: `stop()` stops every component and then rejects
`WORK_DRAIN_UNPROVEN`, and a supervisor only restarts a process that exits.
Nothing durable is at risk: accepted inbound envelopes are persisted before the
Slack ack, and unpublished outbound jobs stay pending until the new process
publishes them.

The tail of `stop()` (health responder, config refresh, database handles, NATS
drain) does not run when the proof rejects, so the process exit closes those
instead. Every component has already stopped by then, so nothing is mid-delivery;
committed SQLite transactions survive the exit, and the outbound consumer is a
durable one (`ravi-channel-outbound`, explicit ack) that stays in place for the
new process.

## Health says so too

A runner the relaunch cannot reach still has to be visible. The relaunch only
helps a runner that runs this code: the runner stuck on 2026-11-19 ran the
previous release, which has no relaunch, and a refusal with matching releases is
one a restart could not end. `ravi channels status` printed its stale-code
warning that day, but its health stayed `ready` (PM2 online, socket connected)
and `ravi doctor` had no check on the runner, so nothing an operator reads after
an install said the runner was refused.

Two signals cover it. The release each process booted with (the boot receipt
bound to its PID and start time) shows drift for any runner, an old one
included, because it needs nothing from the runner. The runner's own state guard
shows what receipts cannot: a refusal while the releases match. The runner
reports it as a `degraded` entry of `adapters`, not as a new snapshot field: the
snapshot's return schema is strict and is generated into six files (two OpenAPI
documents, the Swift and Dart schemas, two TypeScript SDK files), and the health
classification already treats a `degraded` entry as unhealthy and the status
output already prints it.

A refusal is reported from the second refused pass, not the first. Every daemon
boot, on the same release too, runs `initializeStateSchema`, which deletes the
component's marker, prepares the stores and writes the marker back. A runner pass
that falls in that window is refused for the few seconds it takes, and reporting
it would tell the operator who just restarted the daemon to restart it again,
which reopens the window. Two refused passes are 30 s apart at the reconcile
interval, so the state was still not prepared; that is worth saying. This costs
the case that matters nothing: a runner on another release than its daemon is
shown at once by the boot receipts, without waiting for refusals. The count is
refusals since the last accepted pass, so a failure for another reason between
two refusals does not hide them, while the relaunch still wants three in a row.

A release that cannot be verified is never called drift: a status read right
after a restart finds no receipt for the new process yet, and a healthy runner
must not be called broken for that. Stale code alone stays a warning for the same
reason as before: a rebuilt bundle at the same release does not make the guard
refuse anything.
