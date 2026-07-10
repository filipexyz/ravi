# Permissions Checks

## Fail-Closed And Canonical Resolution

- Ravi MUST fail closed when the principal, action, object, or context cannot be
  resolved.
- Permission checks MUST use canonical Ravi subjects and objects, not raw
  provider ids, phone numbers, or chat titles.
- Unknown or unresolved external actors MUST fail closed and receive no
  materialized agent-identity capabilities.

## Provider Runtime And Discovery

- Runtime providers MUST request authorization through the Permission Provider
  Runtime and MUST NOT read unrelated provider storage directly.
- Discovery surfaces (list, show, search, check, autocomplete) MUST filter to
  resources visible to the effective context.

## Shell Hard-Safety Precedence

- Shell hard-safety MUST be evaluated before and independently of capability
  authorization; dangerous patterns and every `UNCONDITIONAL_BLOCKS` executable
  MUST deny under `execute executable:*`, `admin system:*`, and `full-access`.
- A hard-safety denial MUST NOT create a resolvable `permission_denials` row and
  MUST NOT recommend a permission/profile/full-access grant.

## Commands

```bash
bun test src/permissions/provider-runtime.test.ts src/permissions/audit-provenance.test.ts
bun test src/bash/hook.test.ts src/runtime/host-services.test.ts
ravi permissions status --json
ravi specs sync --json
```
