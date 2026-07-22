# Ravi App Runtime Hardening / WHY

## Rationale

Safety and reliability are enforced in the shared router because App-local
conventions cannot protect future adapters. Optional manifest metadata keeps
discovery backward compatible, while execution fails closed only at the risky
boundary. Adapter code still owns vendor parsing, pagination and business
idempotency because the router cannot infer those safely.

## Alternatives Considered

- Rewrite each App CLI: rejected because it duplicates policy and leaves future
  Apps exposed.
- Make manifest check execute health: rejected because discovery must stay
  deterministic and side-effect free.
- Retry all transient HTTP failures: rejected because writes may have committed
  before a timeout was observed.
- Force a new success envelope: rejected to preserve current App payloads.

## Consequences

Existing mutating App operations must declare safety metadata before dynamic
execution. The router result grows additively with typed error and attempt
fields. Readiness becomes a separate explicit command and can therefore be
monitored without changing discovery semantics.
