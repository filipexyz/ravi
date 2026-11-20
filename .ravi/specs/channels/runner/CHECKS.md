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
- [ ] `bun test src/channels/runner-release-guard.test.ts` verifies a runner whose release differs from the state its daemon prepared is refused by the real state guard, relaunches once at 3 consecutive refusals (a failure for another reason ends the run) only while the installed release differs, never relaunches on matching or unknown releases, and cannot be ended by a failing observer, and reports itself refused only from the second refused pass with no accepted pass between them (a single one is a daemon restart on the same release passing through its prepare window, shown with the real state guard).
- [ ] `bun test src/channels/runner-release-status.test.ts` verifies that a runner whose booted release differs from the daemon's is drift (the fix restarts the side behind the installed release), that a reported guard refusal with matching or unknown releases is `refused`, that a release that cannot be verified is never drift, and that the runner's report is a plain `degraded` `adapters` entry.
- [ ] `bun test src/channels/runner.test.ts` verifies the refused guard is reported as a degraded adapter from the second refusal until a pass is accepted, that a single refusal is not, and that a failure that is not a state refusal is not.
- [ ] `bun test src/cli/commands/channels.test.ts` verifies `ravi channels status` is `degraded` for release drift and for a reported refusal, and stays `ready` on matching releases.
- [ ] `bun test src/cli/commands/doctor.test.ts` verifies `channels.runner_release` fails for different releases, warns for a reported refusal, skips what cannot be verified, and that the runner probe cannot hold the doctor.

- `bun test src/cli/env.test.ts` verifies runner restart adopts current env-file values while ordinary CLI calls preserve shell overrides.
