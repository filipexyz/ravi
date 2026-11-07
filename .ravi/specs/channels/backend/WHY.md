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


### Separate terminal persistence from durable text acceptance

A provider can finish once while a transient SQLite failure prevents logical
projection, or while a text sink fails before placing work in the durable outbox.
Retrying the provider duplicates effects; blindly retrying a sink can resend work
already accepted. Inline bounded recovery therefore retains the accepted terminal
and advances only a proven missing phase. Strict request pinning and a versioned
known-adapter acknowledgement preserve that distinction across the runner boundary.
The in-memory operation is not a durable queue and cannot survive process loss.
