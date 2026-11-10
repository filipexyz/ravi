# Slack Native Channel Checks

- [ ] Slack inbound events MUST resolve channel, instance, chat/thread and actor before routing.
- [ ] Slack thread replies MUST fork or resume the correct Ravi thread session.
- [ ] Slack operations MUST be capability-gated by available scopes.
- [ ] Slack message sends MUST use the durable channel outbound boundary.
- [ ] Slack assistant status MUST use native Slack status APIs when available.
- [ ] New Slack skills SHOULD prefer native Slack operations over Omni compatibility.

## DM Pairing Regression

- Run `bun test --preload ./src/test/isolated-runtime-preload.ts src/channels/slack/socket-mode.test.ts`.
- An unknown human DM in pairing is held; after real pending approval, the next DM publishes a prompt with the correct contact actor without an explicit route.
- Intake `off` and `pending`, canonical UUID aliases, and disallowed contact policies remain covered by the Slack socket-mode tests.
