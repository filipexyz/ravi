# Runtime credentials agent-first CLI contract / WHY

The briefing for this wave assumed two braked ops here — `remove` (destructive)
and `exec` (runs something with a credential). Neither exists: the current
surface is `list`, `add`, `import`, `status`, `enable`, `disable`,
`reset-health`, `refresh`, `select`, `classify`. That absence is itself the
finding worth recording. Nothing on this surface destroys a credential or
fires an external side effect through one; `select` and `classify` are pure
previews, `refresh` recovers health state, and `disable` is the reversible
kill switch. Braking any of them would add exit-3 friction to pure maintenance
with no irreversibility to justify it — so this domain ships with declared,
unbraked mutations and a standing rule: the day `remove` lands (the
credential-fallback spec already names it), it is born with `--execute`.

What this domain does need, more than a brake, is secret hygiene in its error
surface. The store was already careful — serializations redact secret refs,
env names and profile paths at the source, and the classifier redacts
authorization headers. The contract work keeps that guarantee at the envelope
layer: `CREDENTIAL_NOT_FOUND` suggestions are built from ids and labels only,
so a typo'd id can never cause an envelope to echo `OPENAI_API_KEY`-style
names, let alone values. The tests prove the negative (envelope string does
not contain the seeded secret env names).

The store throws plain `Error("Runtime credential not found: ...")` from five
different code paths (enable, disable, reset-health, refresh, plus the status
lookup returning null). Wrapping each call site with a message-pattern mapper
(`runCredentialOp`) was chosen over patching the store because the store is a
coverage-gated runtime path (`src/runtime/`) this wave must not touch.
