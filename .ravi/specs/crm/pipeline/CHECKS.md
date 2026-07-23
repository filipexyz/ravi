# CRM Pipeline Canonical Metadata Schema / CHECKS

## Checks

- Empty `{}` metadata MUST validate successfully for backward compatibility.
- Unknown top-level and stage-level keys MUST be preserved.
- Documented fields MUST remain optional unless their parent structured object
  is declared.
- Unknown precondition types MUST warn and pass; they MUST NOT block outbound.
- Missing derivation data MUST be treated as passed by consumer engines.
- Stage key drift MUST warn without blocking metadata writes.
- `bun test src/crm/pipeline-metadata.test.ts src/crm/pipeline-engines.test.ts`
  SHOULD pass after pipeline metadata or engine changes.
