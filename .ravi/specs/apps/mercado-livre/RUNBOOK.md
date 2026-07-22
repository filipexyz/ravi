---
id: apps/mercado-livre
title: "Mercado Livre Native App Runbook"
kind: capability
domain: apps
status: active
normative: false
---

# Mercado Livre Native App / RUNBOOK

## Inspect Phase 1

```bash
ravi apps show mercado-livre --json
ravi apps check mercado-livre --json
ravi ml --help
```

Provider commands intentionally fail closed until Phase 2 supplies a Ravi
credential connection. Do not work around this by reading an SDE token file.

## Add Or Change An Operation

1. Find the current official Mercado Livre documentation for the exact path,
   method, API version, headers and lifecycle constraints.
2. Update `mlOperationMatrix` with the SDE evidence, current official contract,
   migration decision and source URL.
3. If the contract is ambiguous or unavailable, use `estudar` or `aguardar` and
   stop; do not add an executable client method.
4. Classify the operation independently as read, write, destructive or
   financial in client, CLI and manifest.
5. Add a fake-fetch test that asserts the exact method/path/header and proves no
   real provider call is required.
6. Regenerate the command barrel and SDK, then execute all checks in CHECKS.md.

## Phase 2 Credential Onboarding

Phase 2 must introduce a Ravi-owned credential connection and authorization
provider. Before enabling an account:

1. document OAuth ownership, refresh, revocation and redaction;
2. keep SDE credentials isolated and untouched;
3. prove a read-only sandbox/account call first;
4. verify per-risk permission decisions and audit output;
5. enable mutations one command at a time after explicit human approval.

## Diagnose A Failure

- Phase 1 missing credential: expected; no network request occurred.
- HTTP 401/403 after Phase 2: inspect connection ownership/scopes, never print
  the token.
- HTTP 429: use bounded provider-aware backoff; do not retry mutations blindly.
- Missing billing id: inspect the order and retry only after provider billing
  processing.
- Partial item deletion: report both stages; do not retry `deleted=true` without
  inspecting current item state.
- Contract drift: disable only the affected native operation and re-verify the
  current official documentation; do not modify the legacy SDE path.
