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

Agents also need to branch work without waiting for a human to create the
Slack root. Treating programmatic creation as the same native lifecycle keeps
manual and agent-created threads interchangeable: the root remains a real
Slack message, the fork has the same routing contract, and humans can continue
the thread normally.

Internal close is deliberately separate from Slack message state. Slack does
not provide a general "close thread" primitive, while Ravi needs a durable
completion boundary for delegated work. An explicit optional return prevents
routine background branches from interrupting the parent unless they have a
useful result.

## Rejected Alternatives

- Route all thread replies to `route.session`. This collapses every branch into the root session and makes Slack threads mostly cosmetic.
- Treat `thread_ts` as only an outbound delivery hint. This preserves visual Slack threading but loses runtime isolation.
- Create a brand-new unrelated session per thread. This isolates state but loses the useful parent context and prevents provider-level fork where available.
- Publish a normal root message and wait for a human reply to start the fork.
  This is racy and leaves an agent-created branch idle.
- Model close by deleting or editing the Slack root. That destroys conversation
  history and does not represent Ravi's runtime lifecycle.
