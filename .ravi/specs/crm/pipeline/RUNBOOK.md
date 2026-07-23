# CRM Pipeline Canonical Metadata Schema / RUNBOOK

## Debug Flow

1. Read the rules:
   `ravi specs get crm/pipeline --mode rules --json`.
2. Validate a pipeline with `ravi crm pipeline validate <id>`.
3. Use `ravi crm pipeline review <id>` to inspect warnings, partial adoption,
   and suggestions.
4. Use `ravi crm pipeline show <id> --explain` when an engine behaves
   unexpectedly.
5. Check that unknown top-level and stage-level keys are preserved, not stripped.
6. Check that unknown precondition types warn and pass, never block outbound.

## Validation

```bash
bun test src/crm/pipeline-metadata.test.ts src/crm/pipeline-engines.test.ts
```
