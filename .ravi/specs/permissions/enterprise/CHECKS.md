# Enterprise Authorization / CHECKS

## Checks

- Turn-scoped agent identity MUST remain the enforcement core.
- Authority-bearing actions MUST NOT be authorized by absence of a principal.
- Every state, disclosure, delivery, or external-effect decision MUST be
  auditable, including allows.
- Break-glass MUST resolve to an authenticated operator or system principal.
- Audit records MUST be exportable and tamper-evident for regulated
  deployments.
- `bun test src/permissions/provider-runtime.test.ts src/permissions/audit-provenance.test.ts`
  SHOULD pass after enterprise authorization changes.
