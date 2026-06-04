---
id: runtime/product-runtime-layer
title: "Product Runtime Layer"
kind: capability
domain: runtime
capability: product-runtime-layer
tags:
  - runtime
  - products
  - contracts
  - semantic-context
applies_to:
  - src/runtime/product-runtime-contract.ts
  - docs/product-runtime-layer.md
owners:
  - ravi-dev
status: draft
normative: true
---

## Product Runtime Layer

## Intent

Define a narrow runtime port for products to use Ravi without importing Ravi
internals.

This is a runtime contract, not a public API. It exists so Jarvis can use Ravi
for channels, sessions, providers, tools, approvals and trace while keeping
product semantics outside Ravi.

## Rules

- Product consumers MUST NOT import Ravi router/session/database internals.
- Product consumers SHOULD call a runtime port/contract, SDK or adapter surface.
- Ravi MUST own operational execution: session, provider, tools, approvals,
  runtime events, traces and normalized errors.
- Product code MUST own domain semantics, Bridge Contracts, Semantic Events and
  Semantic Abstraction Layers.
- A product runtime request MUST carry a cognitive bounded context envelope.
- The cognitive bounded context MUST include context id, context version, owner
  product and ubiquitous language id/version.
- The cognitive bounded context MUST include concrete ubiquitous language terms
  so the receiving product or agent can reason with the sender's vocabulary.
- When a product runtime request crosses cognitive bounded contexts, it SHOULD
  carry Bridge Contract, Semantic Abstraction Layer and Semantic Event refs.
- Ravi MUST validate presence/correlation of the cognitive bounded context but
  MUST NOT interpret product-specific semantics.
- Product runtime events MUST stay operational. Product-level Semantic Events
  remain owned by the product/framework.

## Cognitive Bounded Context

The envelope should carry:

- context id and version;
- owner product;
- ubiquitous language id/version/terms;
- Bridge Contract refs;
- Semantic Abstraction Layer refs;
- Semantic Event refs;
- assumptions;
- constraints;
- claims;
- provenance refs;
- trace/correlation refs.

Bridge Contract refs describe the semantic agreement between two cognitive
bounded contexts. They MUST NOT be treated as generic CRUD endpoints or a public
API exposed by Ravi.

## Non-Goals

- Do not expose a public HTTP API in this step.
- Do not encode RBBT semantics in Ravi.
- Do not replace Bridge Contracts or SAL.
- Do not implement real Jarvis or Sentinela execution here.
