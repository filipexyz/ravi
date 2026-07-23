# Session Attach / WHY

`sessions/attach` separates where a session listens from where it may speak.
That matters for multi-chat sessions: an inbound can arrive from a muted chat
while the response should go to the selected default output attachment.

The capability replaces old focus-style behavior with explicit subscriptions,
speech mode, and one default output target. It prevents accidental public
responses, hidden output changes, and provider-specific routing shortcuts.
