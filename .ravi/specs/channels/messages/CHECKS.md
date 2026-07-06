# Channel Messages Checks

- [ ] Every stored channel message MUST include channel, instance, chat, actor, direction, timestamp and content.
- [ ] Platform identity MUST be preserved separately from Ravi message id.
- [ ] Unsupported content MUST preserve audit metadata.
- [ ] Edits and deletes MUST target an existing canonical message when one is known.
- [ ] Inbound user messages MUST NOT be the default runtime status anchor.
- [ ] New outbound messages from the same session and chat/thread SHOULD become the preferred runtime status anchor.
