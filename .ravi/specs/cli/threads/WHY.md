# Threads agent-first CLI contract / WHY

Threads are the shared journal agents use to hand work between sessions:
comments, notes, links and a bounded brief. Every write in the domain is a
local SQLite append or status flip with an obvious reverse path — nothing
dispatches execution, nothing deletes, nothing crosses to an external
provider. That is why this wave adds NO write brake: braking `comment` or
`close` would put exit-3 friction inside the cheapest coordination loop in
the product while protecting against nothing irreversible. The migration's
value here is precision on failure: a typed `THREAD_NOT_FOUND` with real
similar slugs beats a plain-text "Thread not found" for an agent that just
mistyped `triagem-venda`.

Two service-layer details shaped the implementation:

- `resolveThread` throws instead of returning null, and `findThread` ALSO
  throws for a different reason (slug ambiguous across scopes). The contract
  helper therefore classifies by message: only `/thread not found/i` becomes
  the envelope; ambiguity stays a legacy failure because suggesting "similar"
  threads for a ref that matches MULTIPLE threads would be actively wrong.
- Suggestions come from `listThreads({ limit: 40 })` — the same local table
  the lookup already touched, so the not-found path costs one extra indexed
  query and reveals nothing that `threads list` would not.

There is no threads skill yet; the gap is registered in the SPEC so the
future skill starts from the contract instead of rediscovering it.
