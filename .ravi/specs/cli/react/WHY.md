# React agent-first CLI contract / WHY

The batch instruction left the react verdict to inspection, and inspection
says UNBRAKED. Three facts drove it:

1. Reversibility is real, not theoretical: on WhatsApp the next reaction
   replaces the previous one and an empty reaction removes it; the Slack
   outbound job built by this very command uses a chat_action contract with an
   explicit `remove` operation.
2. The op is recommended AS the low-friction surface: the sessions usage hint
   tells agents to react "when a lightweight acknowledgement is enough".
   Putting exit-3 friction on the cheapest acknowledgement would push agents
   back to text replies — the opposite of what the hint wants.
3. Blast radius is minimal: a reaction adds no content, pings at most one
   notification, and targets only the CURRENT chat (no `--to` override
   exists).

Because the op stays unbraked, the workspace AGENTS.md example
(`ravi react send ABC123XYZ 👍`) required no change — a deliberate outcome,
since editing AGENTS.md was out of scope.

The contract effort went to the error side instead. The new MESSAGE_NOT_FOUND
gate is best-effort against the local chat ledger and FAIL-OPEN: it only
rejects when the current chat is ledgered and the mid resolves to nothing
there. The asymmetry is intentional — a false rejection blocks a legitimate
ack, while a false acceptance costs an unmatched (and harmless) emit. Ledger
gaps therefore degrade to the old behavior, never to new failures.
