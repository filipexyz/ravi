# Session Actions Runbook

```bash
ravi sessions actions --json
ravi sessions subscriptions
ravi sessions read --json
```

When an expected message is absent:

1. confirm the message was delivered by this session;
2. confirm the chat is still bound or subscribed;
3. inspect the message's origin session provenance;
4. do not widen the query to all messages for the agent.

When an action is unavailable, inspect its per-surface reason code before
calling the underlying command.
