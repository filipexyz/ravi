---
id: routines/composition
title: "Routine Composition Checks"
kind: capability
domain: routines
capability: composition
status: draft
---

# Routine Composition Checks

## Spec Checks

```bash
ravi specs get routines/composition --mode full --json
ravi specs get routines/composition --mode checks --json
ravi specs sync --json
```

## Regression Tests

```bash
bun test src/ci/quality-gate.test.ts
```

## Routine Review

- Every person the routine touches MUST be classified as org member or outsider before the first piece is chosen. An unclassified person counts as an outsider.
- An outsider MUST NOT be given a live data page (a route whose `--uses` lists a `ravi.bases.*` id).
- The routine MUST name its trigger and its context sources separately.
- A reaction-driven approval MUST store the outbound `messageId` on the domain row before the request is shown.
- Every agent write SHOULD carry an `--idempotency-key` derived from its origin, and every update SHOULD carry `--expected-version`.
- The output policy MUST state whether the routine is silent or speaks by default.
- A trigger that drives two unrelated outcomes SHOULD be split into two routines.

## Solution Sheet

- The `solucoes` sheet MUST keep the `Pessoas:` line and the six verbs mapped in the spec (CAPTAR, GUARDAR, MOSTRAR, REAGIR, AGIR, RELATAR). Renaming one MUST update the Solution Sheet section of the spec in the same change.
