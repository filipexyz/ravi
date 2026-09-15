# Channel Backend / WHY

Native providers need different transport admission, identity, thread, and
policy logic, but those differences end before canonical Session/Turn
execution. One durable backend prevents Slack, loaded drivers, and future
providers from accumulating subtly different prompt, retry, runtime-event, and
output semantics.

Wire ingress serves externally loaded drivers. Resolved ingress lets an
in-process adapter preserve its richer Ravi route and canonical provider Chat
without duplicating the backend or creating a second Chat.

A small provider inbox is still necessary when the provider's acknowledgement
deadline is shorter than identity, file, route, or prompt normalization. It
protects the transport edge; the backend receipt protects canonical
Session/Turn publication.

Runtime-state persistence and provider delivery are also separate boundaries.
The runtime state preserves ordered readback; the outbound ledger owns
transport retry and deduplication. Keeping provider API calls out of the
runtime event loop prevents a transient provider failure from losing the only
retryable copy of commentary.
