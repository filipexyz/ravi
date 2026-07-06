# Slack Native Channel Checks

- [ ] Slack inbound events MUST resolve channel, instance, chat/thread and actor before routing.
- [ ] Slack thread replies MUST fork or resume the correct Ravi thread session.
- [ ] Slack operations MUST be capability-gated by available scopes.
- [ ] Slack message sends MUST use the durable channel outbound boundary.
- [ ] Slack assistant status MUST use native Slack status APIs when available.
- [ ] New Slack skills SHOULD prefer native Slack operations over Omni compatibility.
