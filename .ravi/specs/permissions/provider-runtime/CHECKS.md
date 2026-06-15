# Permission Provider Runtime / CHECKS

## Spec Checks

```bash
ravi specs get permissions/provider-runtime --mode rules --json
ravi specs get permissions/provider-runtime --mode full --json
ravi specs sync --json
```

## Static Checks

- Production code outside provider implementations MUST NOT import:
  - `src/permissions/capability-context.ts`
  - `src/permissions/relations.ts`
  - `src/permissions/scope.ts`
- Production code MUST call the provider runtime facade for authorization.
- `src/permissions/provider-runtime.ts` MUST NOT import grant evaluator/store modules
  directly; only provider implementations may do that.
- App routers MUST NOT contain app permission provider request construction,
  env redaction, schema validation, timeout, or decision composition internals.
- Tests MAY import grant-store modules while testing provider implementation
  parity.
- CLI provider-admin commands MAY import provider-owned administration modules.

## Runtime Checks

- No configured provider denies by default.
- Required provider timeout denies.
- Required provider invalid JSON/schema denies.
- Required provider `deny` denies.
- Required provider `needs_approval` denies and returns approval metadata.
- All required providers `allow` permits.
- Optional provider cannot override a required provider denial.
- Local operator execution is authorized through a provider, not a hidden
  no-agent branch inside call sites.
- A no-subject/no-context request without `localOperator=true` denies.
- `agentCan(undefined, ...)` denies.
- `localOperatorCan(...)` allows through the `local-operator` provider only.
- Runtime bootstrap materialization returns no capabilities for `contact` and
  `chat` subjects.
- Runtime bootstrap materialization for `agent` and `automation` subjects does
  not include `admin` capabilities.

## Migration Checks

- Local grants provider parity tests cover representative current checks:
  - tool use;
  - executable execution;
  - CLI group execution;
  - session access/modify;
  - app use/execute;
  - calendar/mailbox read/write;
  - delegated actor/surface authority;
  - temporary grant expiry;
  - superadmin/break-glass.
- Each migrated call site has before/after tests that prove behavior stayed
  compatible or documents intentional behavior changes.
- A final grep for direct grant evaluator/store imports fails CI once
  migration is complete.
