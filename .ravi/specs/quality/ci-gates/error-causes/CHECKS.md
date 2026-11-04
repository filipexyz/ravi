---
id: quality/ci-gates/error-causes
title: Error Cause Ratchet Checks
kind: feature
domain: quality
capability: ci-gates
feature: error-causes
status: active
---

# Checks

- `bun test scripts/error-cause-scan.test.ts` passes fixtures for missing bindings, ignored bindings at surfaces, concrete reasons, dynamic callbacks and shadowed identifiers.
- Git-ref regressions verify missing immutable anchors and comparison refs report the exact ref, full-history/tag recovery instructions, and a nonzero subprocess exit. A missing baseline file in a valid commit remains allowed; malformed baseline JSON still fails.
- On GitHub Actions, verify `Fetch error cause baseline anchor` and `Error cause ratchet` succeed for a PR using its target base SHA and a push using its previous SHA. Rerunning an old workflow does not incorporate this PR's workflow changes.
- Adding `try { work(); } catch { fail("Failed"); }` to a new production file makes `bun scripts/error-cause-scan.ts` fail for an unlisted masking site.
- Adding a no-binding `.catch` callback also fails.
- Forwarding the caught error to the diagnostic constructor removes the violation.
- Logging the caught error and then sending a literal diagnostic fails; using the caught error only in the message, operation or unrelated options also fails.
- Returning or sending a raw error-shaped envelope fails even if it contains the cause or has a concrete `no-cause` annotation. Logging metadata alone is not an envelope.
- A duplicate occurrence cannot increase an existing allowance's count.
- Editing the mutable baseline to add a violation fails against the frozen ceiling and previous branch baseline.
- Editing both JSON baseline files fails comparison with the immutable source commit.
- Removing an allowance without fixing the source fails; fixing the source without removing a stale allowance also fails.
- `bun scripts/error-cause-scan.ts --update` only removes fixed allowances and regenerates the inventory; a missing surface boundary in `checkSurfaceCoverage` fails the harness.
