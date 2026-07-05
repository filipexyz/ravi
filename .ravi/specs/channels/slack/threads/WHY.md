# Why Slack Threads Fork Sessions

Slack users naturally use threads as branches of a conversation. In Ravi terms, that is closer to a session fork than to a simple reply target.

If every Slack thread shares the channel-root session, unrelated work mixes into one provider context and permissions become hard to reason about. If each thread becomes a fully unrelated session, the agent loses the useful context of the parent conversation.

The middle path is a fork:

- the Slack channel remains the container;
- the Slack `thread_ts` creates a Ravi child session;
- the child inherits route, agent and actor/source permissions;
- provider state can fork from the parent when supported;
- future messages in that thread continue in the child.

This matches Ravi's ownership model: Slack supplies the native thread primitive, but Ravi owns session identity, permissions and runtime continuity.

## Rejected Alternatives

- Route all thread replies to `route.session`. This collapses every branch into the root session and makes Slack threads mostly cosmetic.
- Treat `thread_ts` as only an outbound delivery hint. This preserves visual Slack threading but loses runtime isolation.
- Create a brand-new unrelated session per thread. This isolates state but loses the useful parent context and prevents provider-level fork where available.
