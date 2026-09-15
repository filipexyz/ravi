# Delegation / CHECKS

## Checks

- Delegation grants MUST be explicit, auditable, and explainable.
- Effective authority for user-initiated execution MUST be bounded by the
  executor agent ceiling and delegated context.
- Chat or route policy MAY restrict authority but MUST NOT expand it beyond
  actor and agent ceilings.
- Unknown or unresolved actors MUST receive no delegated authority.
- Break-glass authority MUST be distinguishable from normal delegated authority
  in traces and provenance.
- `bun test src/permissions/delegation.test.ts src/permissions/capability-context.test.ts`
  SHOULD pass after changing delegation behavior.
- Externally governed authority is scoped to one explicit provider execution
  compartment and never mutates ambient Agent permissions.
- Signed turn grants cannot exceed the locally accepted provider ceiling or
  local host/provider/runtime guards.
- Wrong audience, binding revision, operation digest, expiry, replay identity,
  or signature fails closed.
- Provider-private Role vocabulary never enters the generic runtime contract.
