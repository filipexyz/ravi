# Checks Do Runner

- [ ] `ravi channels status --json` works without starting adapters.
- [ ] `ravi channels probe --json` starts and stops cleanly.
- [ ] Runner creates `CHANNEL_OUTBOUND`.
- [ ] Runner can run without Slack credentials and report adapter disabled.
- [ ] Runner emits delivery events after adapter send.
- [ ] Runner shutdown closes sockets and NATS.

