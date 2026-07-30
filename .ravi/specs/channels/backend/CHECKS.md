# Channel Backend / CHECKS

- The gate passes only when every ordinary native inbound prompt crosses one
  Channel Backend.
- Acceptance and publication claims MUST remain durable and idempotent across
  process restarts.
- Wire host scope MUST NOT escape its provider or Channel instance.
- Resolved ingress MUST reuse the canonical Chat, Message, Session, Agent, and
  route.
- The gate fails if Slack has a direct ordinary inbound
  `publishSessionPrompt` path.
- Slack message envelopes MUST be durable and secret-redacted before Socket
  Mode acknowledgement.
- Provider inbox retention MUST prune only processed records outside the
  deduplication window.
- Runtime events and output MUST resolve from the accepted binding.
- Local actions MUST be bounded, unique, source-scoped, and locally
  authorized.
- Local-action descriptors MUST cross the runner/daemon boundary only inside
  the trusted accepted-turn envelope.
- Cross-process invocation MUST validate request/result correlation and fail
  closed on missing, stale, ambiguous, or mismatched ownership.
- Local-action failure MUST NOT fall back to shell or another mutation path.
- Public types MUST contain no hosted product entities or private policy.
