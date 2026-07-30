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

The same split means a process-local driver action registry is invisible to
the runtime daemon. A turn-scoped descriptor snapshot plus typed request/reply
keeps handlers and credentials in the runner while letting the daemon expose
only actions admitted for the exact accepted Channel turn.
