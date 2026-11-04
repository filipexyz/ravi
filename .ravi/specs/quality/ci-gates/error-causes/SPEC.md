---
id: quality/ci-gates/error-causes
title: Error Cause Ratchet
kind: feature
domain: quality
capability: ci-gates
feature: error-causes
status: active
normative: true
applies_to:
  - scripts/error-cause-scan.ts
  - scripts/error-cause-baseline.json
  - scripts/error-cause-baseline.frozen.json
  - design/error-cause-inventory.md
---

# Error Cause Ratchet

- CI MUST scan production TypeScript ASTs under `src` before building.
- Every catch clause and promise `.catch` handler MUST appear in the generated inventory.
- A handler without a caught/rejected binding MUST carry an adjacent `// no-cause: <concrete reason>` or an existing frozen allowance.
- A caught binding ignored by a handler that emits a recognized error surface MUST fail the gate unless explicitly documented or grandfathered.
- Merely logging or inspecting the caught binding MUST NOT count as forwarding it. Recognized diagnostic constructors MUST receive a value derived from the caught cause in their diagnostic argument, including through local aliases.
- Returning or sending a recognized raw failure envelope from a handler MUST fail the gate unless grandfathered. A `no-cause` annotation MUST NOT exempt a constructor bypass or classify it as an accepted exception in the inventory.
- Missing bindings, ignored bindings and referenced/dynamic rejection callbacks MUST NOT silently disappear from the inventory.
- Baseline allowances MUST only decrease in identity and occurrence count. New violations, increased duplicate counts, metadata changes and reintroduced allowances MUST fail CI.
- The initial ceiling MUST be recomputed from the immutable baseline commit, so editing both checked-in JSON files cannot expand it. Subsequent PRs MUST also compare against the target branch allowance; pushes compare against the previous commit.
- Removing an allowance while the violation remains MUST fail; fixing a violation MUST remove its stale allowance.
- `--update` MUST only prune existing debt and regenerate documentation. It MUST NOT accept new debt.
- The generated inventory MUST expose total handlers, current debt, baseline debt, closed debt and counts by directory, with one row per handler.
- Static classification is not an end-to-end proof. `fixed` in this inventory means the local AST rule passes; aliases, dynamic execution and cause semantics require the independently enforced runtime corpus.
