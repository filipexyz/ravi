# Complete Tamper-Evident Audit / RUNBOOK

## Debug Flow

1. Read the rules:
   `ravi specs get permissions/enterprise/audit --mode rules --json`.
2. Identify whether the action is sensitive: tool/Bash/CLI mutation,
   contact/CRM write, session access, app execution, gateway egress, permission
   mutation, or break-glass.
3. Verify allow and deny records include decision, mode, principal, executor,
   surface, object, action, timestamp, reason, and safe grant evidence.
4. Confirm records contain no secrets, context keys, raw credentials, or full
   message content.
5. Verify chain/signature integrity and export acknowledgement for configured
   sinks.

## Validation

```bash
bun test src/permissions/audit-provenance.test.ts src/permissions/denials.test.ts
```
