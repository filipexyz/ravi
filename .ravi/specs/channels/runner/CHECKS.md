# Checks Do Runner

- [ ] `ravi channels status --json` MUST work without starting adapters.
- [ ] `ravi channels probe --json` MUST start and stop cleanly.
- [ ] Runner startup MUST create or verify `CHANNEL_OUTBOUND`.
- [ ] Runner MUST run without Slack credentials and report the adapter as disabled.
- [ ] Runner MUST emit delivery events after adapter send.
- [ ] Runner shutdown MUST close sockets and NATS clients.
- [ ] Runner MUST NOT report a Slack adapter as connected before the active socket reports healthy lifecycle state.
- [ ] Runner status MUST reflect connecting, connected, reconnecting, and disconnected transitions for each Slack account.
- [ ] Adapter status MUST include non-secret transition reasons and lifecycle/health timestamps.
- [ ] One Slack account reconnecting MUST NOT regress the status of another healthy Slack account.
- [ ] Runner shutdown MUST suppress late adapter callbacks and MUST leave every stopped Slack adapter disconnected.
- [ ] PM2 process liveness alone MUST NOT be presented as Slack connection health.
- [ ] A PM2 PID change during health probing MUST refresh the process snapshot and retry the replacement PID once.

- [ ] `bun test src/managed-runtime.test.ts` verifies same-path replacement, boot-version preservation and unknown legacy identity with fixed times.
- [ ] `bun test src/cli/commands/daemon-status.test.ts` verifies stale bundle/env projections and non-secret reconcile warnings for both processes.
- [ ] `bun test src/cli/commands/channels.test.ts` verifies healthy transport does not conceal code or env staleness.

- `bun test src/cli/env.test.ts` verifies runner restart adopts current env-file values while ordinary CLI calls preserve shell overrides.
