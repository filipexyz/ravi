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
