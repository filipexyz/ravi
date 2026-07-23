# Channel Presence Checks

- [ ] Presence events MUST be capability-gated per platform and instance.
- [ ] Runtime status MUST include origin session, channel, instance, chat/thread and state.
- [ ] Runtime status MUST be scoped by session and chat/thread.
- [ ] Runtime status MUST clear on terminal state or expire by TTL.
- [ ] Inbound user messages MUST NOT be used as the default runtime status anchor.
- [ ] Slack assistant status MUST use the stable Slack thread timestamp.
