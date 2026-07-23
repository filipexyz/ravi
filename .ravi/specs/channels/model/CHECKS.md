# Channels Model Checks

- [ ] Canonical entities MUST include channel, instance, chat, thread, actor, message, delivery, presence, capability and credential concepts.
- [ ] Platform ids MUST remain separate from Ravi ids.
- [ ] Session state MUST NOT be stored as part of `ChannelChat` or `ChannelThread`.
- [ ] Chat/thread subscriptions MUST support many-to-many relationships with sessions.
- [ ] Omni compatibility fields MUST NOT become canonical model requirements.
- [ ] `ChannelStatusAnchor` MUST identify the target surface for runtime status by session and chat/thread.
