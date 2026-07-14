# Runtime Target Failover Operator CLI / WHY

## Rationale

The failover engine already owns selection and replay safety. This feature does
not introduce another policy store or a parallel management service; it makes
the existing typed policy operable through the native Ravi CLI.

Stable target ids are the reorder key because provider names are not unique: an
agent may have multiple Codex, Claude, Pi, or future-provider targets with
different models and credential requirements. Requiring an exact permutation
turns reorder into a deterministic, lossless operation and rejects typos before
configuration changes.

`set --order` extends the existing mutation instead of adding a new `reorder`
verb. This keeps the surface KISS and follows Ravi's concrete verb conventions.
Complete creation/replacement remains available through `--policy-json`; common
day-two operation no longer requires reconstructing the entire JSON document.

`show` and `explain` are intentionally distinct. `show` returns configured
policy data; `explain` resolves eligibility and provenance at the current time.
Neither executes a provider.

The skill is intentionally thin. Durable behavioral rules and exact syntax live
in `ravi runtime targets <command> --help`, preventing skill/help drift while
still giving agents a discoverable trigger and workflow.

Rejected alternatives:

- Hard-code `claude,pi,codex` as a default: violates provider neutrality.
- Reorder by provider name: ambiguous for N targets per provider.
- Store named policy rows in a new table for this UX increment: unnecessary;
  the existing agent-default policy is already durable and auditable.
- Teach raw database or `ravi agents set defaults` edits: bypasses validation
  and can overwrite unrelated configuration.
