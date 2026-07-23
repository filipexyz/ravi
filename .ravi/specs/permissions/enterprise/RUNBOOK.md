# Enterprise Authorization / RUNBOOK

## Debug Flow

1. Start with the umbrella:
   `ravi specs get permissions/enterprise --mode rules --json`.
2. Keep turn-scoped agent identity as the enforcement core. Enterprise features
   wrap it; they do not replace it with ambient authority.
3. For audit questions, read `permissions/enterprise/audit`.
4. For recovery paths, read `permissions/enterprise/break-glass`.
5. Verify every authority-bearing allow has an authenticated principal and
   exportable audit provenance.
6. For governance reads, use persisted provider/runtime state, not ad hoc log
   reconstruction.

## Validation

```bash
bun test src/permissions/provider-runtime.test.ts src/permissions/audit-provenance.test.ts
```
