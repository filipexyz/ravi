# Channel Messages Checks

- [ ] Every stored channel message MUST include channel, instance, chat, actor, direction, timestamp and content.
- [ ] Platform identity MUST be preserved separately from Ravi message id.
- [ ] Unsupported content MUST preserve audit metadata.
- [ ] Edits and deletes MUST target an existing canonical message when one is known.
- [ ] Inbound user messages MUST NOT be the default runtime status anchor.
- [ ] New outbound messages from the same session and chat/thread SHOULD become the preferred runtime status anchor.
- [ ] Persisting or replaying a channel message MUST NOT implicitly create a provider turn.
- [ ] Only explicitly admitted provider ingress materializes a canonical prompt turn.
- [ ] One stable admission identity MUST produce at most one turn across retries.
- [ ] Generic ChannelBackend code MUST NOT infer provider-private execution intent.
