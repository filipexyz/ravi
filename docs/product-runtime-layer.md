---
title: Product Runtime Layer
description: Product-facing Ravi runtime contract for semantic product execution.
---

## Product Runtime Layer

This document defines the first contract for using Ravi as a runtime layer for a
product such as Jarvis.

It is **not** a public HTTP API and it is not a promise that product domains
should depend on Ravi internals. It is a runtime port: a narrow contract between
product logic and Ravi's channel/session/provider/tool/approval/trace runtime.

## Position

```text
Product Core
  -> Product Runtime Port
  -> Ravi Runtime
  -> Runtime Provider
```

The product owns domain semantics. Ravi owns runtime execution.

This is deliberately a product runtime contract, not an exposed product API. A
bridge between products is a semantic boundary between cognitive bounded
contexts, so the runtime request must carry the meaning needed to reason across
that boundary.

## Core Rule

Ravi must not become the product's semantic boundary.

When one agent/product asks another context to act or reason, the runtime request
must carry the semantic context that gives the target enough meaning to answer.
That context includes the source cognitive bounded context, its ubiquitous
language, bridge contract refs, semantic abstraction layer refs, semantic event
refs, assumptions, claims, constraints, provenance, and correlation ids.

Ravi validates and transports that envelope. Ravi does not interpret product
semantics.

## Contract Layers

### Product Runtime Request

The request tells Ravi what to execute operationally:

- request id;
- source product;
- actor;
- intent;
- input;
- execution options;
- trace/correlation refs;
- cognitive bounded context.

### Cognitive Bounded Context

The cognitive bounded context tells another product or agent what language and
understanding the request is carrying:

- context id and version;
- owner product;
- ubiquitous language id/version/terms;
- bridge contract ref;
- semantic abstraction layer ref;
- semantic event refs;
- assumptions;
- constraints;
- semantic claims;
- provenance refs.

This layer is required because product bridges are semantic boundaries, not just
transport boundaries.

The target side should be able to tell which cognitive bounded context produced
the request, which ubiquitous language is being used, which contract governs the
interaction, which SAL projection shaped the data, and which semantic events
created the current interpretation.

### Product Runtime Events

Ravi returns normalized runtime events:

- accepted;
- context loaded;
- approval requested;
- response delta;
- response completed;
- failed.

These are operational runtime events. Product-level Semantic Events remain owned
by the product/framework using Ravi. Ravi may carry references to those events in
the cognitive context, but it must not reinterpret or rewrite them.

## Non-Goals

- Do not expose a public Ravi HTTP API in this step.
- Do not make Jarvis import Ravi router/session/database internals.
- Do not encode RBBT product semantics inside Ravi.
- Do not replace product Bridge Contracts, Semantic Events or SAL.
- Do not treat Bridge Contracts as CRUD endpoints or low-level integration APIs.

## First Consumer

The first intended consumer is Jarvis.

The first target flow is:

```text
WhatsApp -> Ravi Runtime -> Jarvis Runtime Port -> Jarvis Core -> SAL fixture
```

Real product integration should happen after the product publishes stable
semantic contracts.
