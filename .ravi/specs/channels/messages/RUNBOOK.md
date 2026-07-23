# Channel Messages Runbook

1. Normalize every inbound platform event into a canonical `ChannelMessage`.
2. Preserve platform ids and raw metadata separately from canonical fields.
3. Resolve replies, quotes, edits, deletes and reactions against canonical message ids when possible.
4. Store unsupported content with enough metadata for audit and later parser improvement.
5. For outbound messages, persist the canonical message before using it as a runtime status anchor.
