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
- Runtime event sinks MUST receive the validated external target.
- Host response policy MUST run before assistant content reaches a transport
  sink.
- Commentary MUST be delivered independently from terminal output through the
  durable outbound ledger with the event ID as its idempotency key.
- Commentary delivery MUST NOT create a canonical Chat Message; runtime event
  readback remains authoritative.
- Terminal delivery MUST attach provider identity to the assistant Message
  already persisted for the Turn and MUST NOT insert a second canonical
  Message.
- Terminal delivery MUST use the accepted binding's canonical Chat identity,
  fail closed before handoff when canonical state is absent, and MUST NOT
  retry a provider send after a permanent post-send canonical mismatch.
- A permanent post-send canonical mismatch MUST publish a provider-sent,
  canonical-rejected delivery record and terminalize its durable receipt
  before the job is acknowledged. Retrying that bookkeeping MUST NOT call the
  provider again.
- Interrupted, sentinel, suppressed, and unknown-phase assistant content MUST
  NOT enter commentary delivery.
- Public types MUST contain no hosted product entities or private policy.

- `terminal-projection-recovery.test.ts` MUST distinguish unchanged preterminal,
  exact ambiguous commit, conflicting/unknown readback, owner loss, exhaustion
  and post-commit callback error without repeating callbacks or physical work.
- `terminal-output-handoff.test.ts`, `backend-egress.test.ts` and the SDK registry
  tests MUST cover immutable pinning, unsupported-version/capability refusal
  before sinks, malformed/generic ACKs, bounded pre-save retry and no unknown retry.
- Existing host/Slack terminal fixtures MUST prove automatic recovery of only
  the missing logical/text stage, with one physical terminal and independent media.
- Runtime/SDK registries and egress MUST preserve bound `unknown(false)` evidence
  with no pin, a matching pin or a different actual fingerprint. A later unknown
  fingerprint MUST stop the terminal retry without replacing the first pin or
  asserting completion; finished mismatches MUST remain conflicts.
