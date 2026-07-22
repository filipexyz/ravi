# Tiny / CHECKS

## C1 — Manifest And Help

```bash
bun src/cli/index.ts apps check tiny --json
bun src/cli/index.ts tiny help --json
```

Expected:

- `ok == true`, zero manifest errors;
- 22 of 25 declared CLI operations have complete structured help;
- `tiny.conta-receber-estornar`, `tiny.conta-pagar-estornar` and
  `tiny.webhook-incluir` are intentionally incomplete with
  `missing=[officialEndpoint,immutableOfficialEvidence,officialQuota]` until an
  immutable official REST contract is verified;
- each of those three gaps keeps `officialDoc=null`, provenance `low`/`gap`,
  quota `unknown`, an explicit owner, `liveGate=no-go` and `complete=false`;
- each write preview declares `tiny:write` or `tiny:destructive`;
- safety declares HITL, confirmation, dry-run and operation-specific cutover gates;
- help includes examples, schema validation, endpoint/provenance and quota policy.

## C2 — Tenant And Secret Boundary

```bash
bun src/cli/index.ts tiny config-check --tenant sde --json
bun src/cli/index.ts tiny info --tenant sde --dry-run --json
```

Expected:

- tenant config contains only broker provider/connection metadata;
- no token, client secret, secretRef or secret value appears;
- absent/inactive broker connection is observable and live read fails closed;
- dry-run does not resolve a secret or call Tiny.

The task-scoped live parity proof MUST use a temporary credential database and
backend, resolve action `<operation>.read`, and compare the App/legacy result without
printing account values or token.

## C3 — Live Host Pin

`client.test.ts` MUST reject a non-Tiny live host before a credential could be
sent and MUST reject the v2-only `info` plan for a v3 tenant.

## C4 — Live Broker Read

The task-scoped proof MUST produce exactly one successful broker audit event for
`<operation>.read`, pass no `TINY_TOKEN` environment to the App process and obtain
the same redacted shape/digest as the legacy read.

## C5 — Write Permissions And Gates

The scoped manifest/tests MUST report all 17 writes as
permission/HITL/confirmation gated and `gateIssues=[]`.

## C6 — Write Execution Disabled

```bash
bun test src/apps/tiny/write-contracts.test.ts src/apps/tiny/manifest.test.ts
```

Expected for all 17 previews:

- schema validation passes for a valid fixture and pinpoints invalid fields;
- `executionEnabled=false`, `networkCalled=false`, `secretResolved=false`;
- `hitlRequired=true`, `confirmationRequired=true`, `idempotent=false`;
- output carries only schema ref, top-level field names and digest, never values;
- missing `--dry-run` and any `--yes` attempt fail closed;
- stock movement type is explicit; finance/doc, webhook/doc and v3/OAuth gaps stay visible.

## C7 — Preview Redaction

The shared output schema and tests MUST pin `executionEnabled=false`,
`networkCalled=false`, `secretResolved=false`, `valuesExposed=false`, while
returning only schema ref, top-level fields and SHA-256 digest.

## C8 — Document And Lifecycle Gaps

Inspection and focused tests MUST keep independent v1 docs, webhook v2 docs and
the financial official/legacy mismatch as explicit gaps. In particular,
`conta-receber-estornar` and `conta-pagar-estornar` MUST remain
`officialDoc=null`, provenance `low`/`gap`, quota `unknown`, owner explicit,
`liveGate=no-go`, `complete=false` and materially incomplete while immutable
official evidence is absent. A non-empty URL string that was not independently
verified MUST NOT promote any operation to `high`, `established`, documented or
complete. OAuth v3 lifecycle may be GO offline only when
bundle/expiry/refresh/rotation/audit fail-closed tests pass; missing consent,
persistent connection or live auth remains an explicit NO-GO live gap.

## C9 — Retry And Quota Policy

Every write preview MUST declare `retryAutomatically=false`, `maxInFlight=1`,
`minIntervalMs=3000` and `maxAttempts=1`. V2 MUST expose the official plan
limits `0/30/60/120` requests/minute (`20` for discontinued plans), batch `5`,
up to `20` records/request, `100` records/response, concurrency recommendation
`1/4` and `x-limit-api`. `officialAlwaysBatchOperations` MUST contain all eight
published services (contact/product/group-tag/tag include+alter), while
`migratedAlwaysBatchOperations` MUST identify the current four-operation
contact/product subset. V3 MUST expose total/write plan buckets
`60/30`, `120/60`, `240/100` and `X-RateLimit-*`. Unknown endpoint-specific
quota fields MUST remain `null`, never inherited from the legacy `100/min`
assumption. An operation without verified immutable official evidence MUST keep
quota `unknown` even if a legacy command or an unverified `officialDoc` URL
exists.

## C10 — Scoped Read Wave 1 Parity

```bash
bun test src/apps/tiny/read-wave-1.test.ts src/apps/tiny/read-contracts.test.ts src/apps/tiny/client.test.ts src/apps/tiny/manifest.test.ts
```

Expected:

- `src/apps/tiny/oracles/read-wave-1.oracle.json` is sanitized, versioned and
  explicitly independent from SDE, `ravi.app.json` and `generate-manifest.ts`;
- the oracle pins `read-wave-1.sde-baseline.json`, a sanitized immutable snapshot
  of SDE commit/tree/blob hashes, legacy command/args, normalized cases and review
  provenance; missing/tampered baseline or any SDE↔App divergence fails closed;
- `expectedOperations` and `implementedOperations` are the same six reads:
  `info`, `contatos`, `contato`, `produtos`, `produto`, `estoque`;
- `coverage.total=6`, `readOnly=6`, `helpComplete=6`, with zero missing,
  extra, command mismatch, contract mismatch or gate issue;
- every operation matches the independent command/args/endpoint/input/output
  contract and passes nominal, empty, error, pagination or explicit
  `not-applicable`, tenant-isolation and output-schema checks with injected
  offline fetches; every successful envelope includes required
  `retorno.status_processamento` and validates against the pinned JSON Schema;
- negative tests mutate the manifest command, wave denominator and every parity
  dimension while keeping the oracle fixed, and MUST observe `ok == false`;
- warnings expose oracle/baseline SHA-256 plus pinned SDE commit and state that this is a scoped oracle
  wave, not full namespace or connector parity; the boundary remains 171
  connector operations plus 37 SDE workflows, and SDE remains fallback;
- no Tiny network call, credential resolution, write, deploy, restart or cutover.

## Quality Gates

```bash
bun test src/apps/tiny/read-contracts.test.ts src/apps/tiny/read-wave-1.test.ts src/apps/tiny/client.test.ts src/apps/tiny/write-contracts.test.ts src/apps/tiny/manifest.test.ts src/apps/tiny/oauth.test.ts src/apps/tiny/credential.test.ts src/credentials/broker.authorization.test.ts
bunx biome check src/apps/tiny/
bun run typecheck
ravi specs get apps/tiny --mode checks --json
```

No deploy, daemon restart, Tiny write, permission grant or production credential
provisioning is part of these checks.
