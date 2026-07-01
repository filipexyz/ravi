# Credentials Controls / WHY

## Problem

Security controls for credential handling (redaction, fail-closed behavior, env fallback policy, audit) must be consistent across all credential consumers. Without centralized controls, each consumer implements its own redaction filters, fail-closed logic, and audit patterns — leading to gaps where secrets leak through overlooked output surfaces.

## Decision

Define a `credentials/controls` capability that specifies cross-cutting security rules applied uniformly to all credential consumers. These controls govern what MUST be redacted, when resolution MUST fail closed, how temporary env fallback works, and what MUST be audited. Both runtime provider and channel credential consumers are bound by the same controls.

## Tradeoff

Centralized controls add constraints that every credential consumer must follow. This is intentional: consistent security is worth the rigidity. The alternative — per-consumer controls — has proven to produce gaps in redaction and authorization.
