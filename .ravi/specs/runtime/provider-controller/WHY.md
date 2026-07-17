# Runtime Provider Controller / WHY

## Rationale

Ravi already has a good low-level model: adapters run one target, credential
fallback owns credential health, and target failover owns cross-provider
switching. The missing product behavior is the operator layer that applies those
primitives consistently across agents and makes the result explainable.

The controller is intentionally thin. It should decide "which explicit policy
should this agent have?" and "is the required access visible and healthy?"
Then the existing runtime target policy executes the turn. This keeps provider
switching deterministic and auditable without adding provider-specific branches.

The KISS rollout writes explicit agent-default policies first. That uses the
current precedence contract and avoids changing SDK source enums or runtime
resolver semantics until a spike proves a new source is necessary.

## Alternatives Considered

### Hidden fallback from installed credentials

Rejected. It would violate `runtime/target-failover`, where core never assigns a
universal provider order and fallback is explicit. It also makes incident review
hard because an installed provider profile can silently affect unrelated agents.

### Put fallback logic inside each provider adapter

Rejected. Provider adapters must execute exactly one resolved target. Local
fallback inside Claude, Codex, Pi, or future adapters bypasses trace, replay
safety, credential health, and operator explainability.

### Add `controller_default` as v1 resolver precedence

Deferred. It may be useful later, but it changes public SDK and explain output.
The first rollout can materialize policies into agent defaults and preserve the
existing resolver contract.

### Store provider chains only in settings

Deferred unless `runtime_target_policies` is not viable. Templates should be
versioned and hashable. If the existing policy table is real, it is a better fit
than opaque settings. If it is dead storage, the implementation must either
revive it with tests or choose a simpler existing store deliberately.

### Do nothing beyond fixing classifiers

Rejected. Classifier fixes are necessary, but they do not answer the fleet
question: which agents are controlled, what fallback chain do they have, and
which access path will be used?

### Implement the external Provider Cascade draft literally

Rejected as a direct implementation. The draft is strong as a requirements and
risk-analysis input, but it proposes a standalone provider catalog, provider
health tables, `src/providers` module tree, and `ravi providers ...` surface
that would duplicate current Ravi runtime primitives. The current codebase
already has runtime providers, runtime target policies, credential fallback,
credential status, provider adapters, and SDK/registry surfaces. The controller
must compose those primitives instead of replacing them.

## Consequences

Positive consequences:

- Operators can audit and apply provider behavior before production incidents.
- Existing runtime target failover remains the single execution path.
- Mass changes can be dry-run and rolled back by policy id/hash.
- Future agents can inherit behavior through explicit templates rather than
  ambient environment state.

Accepted trade-offs:

- V1 may duplicate policy snapshots into agent defaults. That is acceptable
  because it preserves runtime determinism and keeps the resolver simple.
- Provider-native credential inventory may begin as read-only diagnostics before
  full health management.
- The controller will not magically use every authenticated provider; providers
  must be named by policy and represented in access diagnostics.
