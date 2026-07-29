# Channel Backend / CHECKS

- Every ordinary native inbound prompt crosses one Channel Backend.
- Acceptance and publication claims are durable and idempotent.
- Wire host scope cannot escape provider or Channel instance.
- Resolved ingress reuses canonical Chat, Message, Session, Agent, and route.
- Slack has no direct ordinary inbound `publishSessionPrompt` path.
- Slack message envelopes are durable and secret-redacted before Socket Mode
  acknowledgement.
- Provider inbox retention prunes only processed records outside the
  deduplication window.
- Runtime events and output resolve from the accepted binding.
- Local actions are bounded, unique, source-scoped, and locally authorized.
- Public types contain no hosted product entities or private policy.
