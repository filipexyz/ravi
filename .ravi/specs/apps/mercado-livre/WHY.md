---
id: apps/mercado-livre
title: "Why Mercado Livre Is A Native Ravi App"
kind: capability
domain: apps
status: active
normative: false
---

# Mercado Livre Native App / WHY

The SDE CLI is useful migration evidence but combines provider calls,
credentials and some cross-domain business workflows. Treating it as the sole
API contract would preserve deprecated paths and make unsafe composites look
like ordinary provider operations.

The native app therefore starts from current official provider documentation,
uses SDE only to enumerate behavior, and records an explicit decision for every
legacy operation. This makes omissions intentional and reviewable.

Phase 1 is deliberately useful without pretending to be operational: it gives
Ravi a typed CLI, manifest, SDK surface, permission classes and deterministic
tests while authentication remains fail-closed. That boundary prevents a local
legacy token from becoming an accidental fleet-wide credential dependency.

Financial reads are separated from financial mutation because amounts and
fiscal identity are sensitive even when no money moves. Destructive catalog
operations are also distinct from reversible writes because closing and deleting
listings have different recovery properties.

The legacy remains intact so migration can proceed operation by operation after
Phase 2 credentials and live read-only proof exist. No cutover is implied by
the presence of the native app.
