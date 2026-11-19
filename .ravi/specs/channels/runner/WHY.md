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
