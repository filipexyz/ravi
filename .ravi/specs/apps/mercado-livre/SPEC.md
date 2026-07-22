---
id: apps/mercado-livre
title: "Mercado Livre Native App"
kind: capability
domain: apps
capabilities:
  - mercado-livre
  - cli
  - catalog
  - sales
  - shipping
  - post-sale
tags:
  - apps
  - mercado-livre
  - migration
applies_to:
  - src/apps/mercado-livre
  - src/cli/commands/ml.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Mercado Livre Native App

## Intent

Provide a first-party Ravi App for the current official Mercado Livre API while
keeping the `sde ml` implementation available and unchanged during migration.

Phase 1 owns the native app contract, client, CLI, operation permissions and
local verification. Real OAuth credentials and authenticated provider calls are
explicitly deferred to Phase 2.

## Invariants

- Provider paths and methods MUST be backed by current official Mercado Livre
  documentation recorded in `contract.ts`.
- An operation without an unambiguous current official contract MUST remain
  absent from the executable client and MUST be marked `estudar` or `aguardar`
  in `mlOperationMatrix`.
- The native client MUST NOT read SDE token or configuration files.
- Without an injected Ravi authorization provider, every provider operation
  MUST fail before network access.
- Phase 1 MUST NOT contain a token, secret, authenticated fixture or production
  write.
- The legacy `sde ml` files and command surface MUST remain unchanged.
- Read, write, destructive and financial operations MUST be distinguishable in
  the client risk, CLI access metadata and app manifest permissions.
- Every provider mutation MUST require explicit `--confirm` and fail before
  authorization when confirmation is absent.
- Generic item update MUST reject price, lifecycle and deletion fields. These
  operations require a dedicated contract; price writes are unavailable in
  Phase 1.
- Item close and two-step deletion MUST use destructive access metadata and
  `ml:catalog:destructive`, distinct from reversible catalog writes.
- Billing data, shipment costs, price reads and Product Ads reads MUST use
  `ml:financial:read`; this read permission MUST NOT authorize financial writes.
- The app MUST be stateless in Phase 1. Provider responses and credentials MUST
  NOT be persisted.
- CLI commands MUST declare `@CommandAccess`, `@Returns`, actionable help and a
  stable JSON result envelope.

## Current Official Divergences From SDE Evidence

- Billing information is resolved from `buyer.billing_info.id` on the order and
  read from `/orders/billing-info/{site}/{billing_info_id}`. The old
  `/orders/{id}/billing_info` path is deprecated.
- Current Product Ads reads use campaign API version 2 and `ad_groups`; removed
  legacy `ads/search` operations MUST NOT be copied.
- Current official documentation does not make standard-price writing
  available. No native price mutation is exposed.
- Postage combines Mercado Livre, Tiny, SEFAZ and label rendering. It remains a
  legacy composite workflow until each domain contract and irreversible step is
  specified independently.

## Boundaries

- Phase 1 does not onboard OAuth, broker credentials or test an authenticated
  account.
- Phase 1 does not publish, change, pause, close or delete a real item and does
  not send a real answer or message.
- Phase 1 does not migrate label artifacts, fiscal issuance, payments,
  cancellation, purchases or Product Ads mutations.
- Manifest permissions are requirements and audit metadata, never grants.

## Validation

- The manifest passes the Ravi Apps checker without executing a provider health
  command.
- Unit tests prove fail-closed authentication, current paths/headers, redaction,
  risk classification and confirmation gates with injected local fakes.
- Registry and generated SDK checks pass with typed returns.
- The full repository typecheck, tests, build and Biome checks pass before the
  migration is considered locally complete.
