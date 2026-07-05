# Events / WHY

## Rationale

Ravi publishes NATS events across many domains (sessions, contacts, triggers, cron, heartbeat, config, audit, delivery, etc.), but there was no domain spec that owns the event infrastructure as a whole. The audit stream subject list, trigger topic catalog, and event naming conventions were implicitly governed by individual domain specs without a unifying owner.

## Decisions

- Create an explicit `events` domain that owns the audit stream, trigger topic catalog, and event subject conventions.
- Use the domain spec as the anchoring point for gap analysis and future coverage tracking.
- Keep the scope narrow: the events domain owns subject registration and payload safety rules, not the transport layer or trigger execution runtime.

## Rejected Alternatives

- Leaving event infrastructure without a domain spec. This makes it unclear who owns the audit stream subject list and trigger catalog invariants.
- Merging event ownership into the `runtime` domain. Events span far beyond runtime (contacts, config, CLI audit, permissions), so a dedicated domain is cleaner.
