---
id: apps/frete
title: "Frete"
kind: capability
domain: apps
capability: frete
capabilities:
  - manifest
  - cli
  - sdk
  - quote
  - permissions
tags:
  - apps
  - frete
  - logistics
  - olist
applies_to:
  - src/apps/frete
  - src/cli/commands/frete.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Frete

## Intent

Expor cotacao de frete como Ravi App nativo, tipado e permissionado, usando o
contrato oficial atual da Olist sem depender do SDE e sem contratar transporte.

## Invariants

- The App MUST use the official Olist quote contract documented at
  `https://tiny.com.br/api-docs/api2-cotacao-fretes`.
- Phase 1 MUST expose only `frete.quote`, semantically read-only even though the
  official transport is HTTP POST.
- The native client MUST NOT call `sde`, read legacy credential files, or use
  FM, GoFretes or J3 private endpoints.
- Missing Ravi credentials MUST fail closed before any network request.
- Credentials MUST NOT be accepted as CLI arguments, printed, logged, returned,
  persisted by the App, or stored in the manifest.
- Tests MUST use injected placeholder credentials and fake fetch only.
- Shipment creation, contracting, payment, dispatch, label purchase and
  cancellation MUST NOT be implemented in Phase 1.
- The legacy SDE command MUST remain untouched and available as fallback.
- Legacy `--markup` and `--lista` behavior MUST NOT be copied without a
  separately approved business contract.
- The App MUST remain stateless; a quote response is recalculable and does not
  add durable lineage or recovery value in Phase 1.

## Official API Contract

- Method/URL: `POST https://api.tiny.com.br/webhook/api/v1/parceiro/{idEcommerce}/cotar`.
- Credential shape: account credential in the `Token` header, resolved only
  through Ravi's credential boundary after onboarding.
- Required request fields: destination CEP and at least one item SKU.
- Optional request fields: origin CEP, quantity, dimensions/weight and official
  grouping/preparation options.
- Response fields: delivery type, price, deadline, Olist shipping form ids and
  names, grouped either by SKU or as a combined quote.

## Operation And Permission Matrix

| Class | Operation | Phase 1 | Permission |
| --- | --- | --- | --- |
| read | `frete.quote` | implemented | `frete:quotes:read` |
| write | shipment/document mutation | not implemented | `frete:shipments:write` |
| destructive | cancellation | not implemented | `frete:shipments:destructive` |
| financial | contract/purchase/payment | not implemented | `frete:charges:financial` |

Reserved permissions are boundaries, not grants and not evidence that an
operation exists.

## Interfaces

- CLI: `ravi frete quote <integrationId> <destinationCep> <sku> --json`.
- SDK namespace: `frete` generated from the decorated command registry.
- Manifest: `src/apps/frete/ravi.app.json`.

## Versioning

- Adding verified read-only quote fields is a minor App change when backwards
  compatible.
- Adding write, destructive or financial operations requires explicit HITL,
  new tests and permission review.
- Replacing the official provider contract or changing the stable JSON return
  shape requires a major App compatibility decision.
