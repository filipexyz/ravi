# Checks Do Runner

- [ ] `ravi channels status --json` MUST work without starting adapters.
- [ ] `ravi channels probe --json` MUST start and stop cleanly.
- [ ] Runner startup MUST create or verify `CHANNEL_OUTBOUND`.
- [ ] Runner MUST run without Slack credentials and report the adapter as disabled.
- [ ] Runner MUST emit delivery events after adapter send.
- [ ] Runner shutdown MUST close sockets and NATS clients.
