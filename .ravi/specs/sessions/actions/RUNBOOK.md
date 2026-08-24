# Session Actions Runbook

```bash
ravi sessions actions --json
ravi sessions subscriptions
ravi sessions read --json
ravi sessions recap --json
ravi sessions create-thread "Initial work" --model <model>
ravi sessions close-thread --return "Result for the parent"
```

When an expected message is absent:

1. confirm the message was delivered by this session;
2. confirm the chat is still bound or subscribed;
3. inspect the message's origin session provenance;
4. do not widen the query to all messages for the agent.

When an action is unavailable, inspect its per-surface reason code before
calling the underlying command.

For thread actions, confirm `effectiveSurface.channel=slack`. Close is expected
to be unavailable from a channel-root session.
