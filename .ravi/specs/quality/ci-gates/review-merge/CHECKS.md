---
id: quality/ci-gates/review-merge
title: "Review Merge Gate Checks"
kind: feature
domain: quality
capability: ci-gates
feature: review-merge
status: active
---

# Review gate verification

## 1. Historical snapshot checks

- The 31/10 snapshot has its timestamp, old ruleset id and old settings, and is
  labelled historical in every companion. It does not say those controls
  remain required today.
- The old JSON is identified as a historical design, not an installation
  recipe for the independently governed replacement.
- The earlier reviewer-off exception remains audit history; removal of its
  ruleset is not reported as successful restoration or closure.

## 2. Current-policy checks

Read the rulesets list and effective `dev` rules via GET as documented in the
runbook; save the observation time. At the 01/11 snapshot:

- `rulesets/26284495` returns 404.
- Remaining ids are `18436907`, `18533706`, `18436625`.
- The only required status check is `Quality Gate`; `Review Gate` and
  `Review Gate Tests` are not required.
- Copilot/code-quality rules are not described as independent-review or
  conversation-resolution requirements.
- The document explicitly states that a PR with a reproduced credential
  finding can merge if the actual required checks/platform conditions permit
  it; an advisory review failure is not a server-enforced blocker.

Do not merge a vulnerable PR to prove this gap. Readback plus the absence of
an enforcing review condition is the evidence, with no claim that another
unrelated quality test could never fail.

## 3. Recommended replacement acceptance — not implemented by this PR

Independent review of the replacement MUST verify:

- An author's envelope, including a renamed/nested/second session or agent
  label under the same authority principal, cannot create an approval.
- The author/PR execution cannot read the signing key, mutate trusted keys,
  change verifier policy, access the App's check credential, or cause a signing
  service to attest an author-supplied verdict as an independent reviewer.
- Missing, forged, tampered, untrusted, expired or replayed attestation fails.
- Wrong repo/PR/head/base/tree/contract/policy/evidence binding fails; a new
  candidate invalidates the old approval.
- An unresolved reproduced credential finding fails even when Quality Gate
  passes. Only independently verified resolution or a technically justified,
  independently signed disposition can change that finding's outcome.
- Signer/verifier/reviewer unavailability and incomplete API/evidence reads
  fail closed, rather than accepting cached or missing approval.
- A same-named Actions check or wrong App publisher cannot satisfy the
  required gate. The trusted App's own advisory-only success is insufficient.
- Effective branch rules require the gate with its dedicated App identity;
  author-accessible bypasses are absent and Quality Gate remains required.
- Candidate and finding/review-state changes invalidate stale results,
  including changes not covered by existing Actions event subscriptions.
- A correctly bound, valid independent signature with resolved findings and
  passing verification is eligible; a check success is not a claim that a
  merge has been executed.

Record independent verification of custody, effective policy and these cases,
plus authorized actor and activation time, before claiming enforcement. A unit
test pass, a signed envelope from the author's key or an App installation alone
cannot close the gap. Settings and permissions remain outside this PR's scope.

## Existing evaluator regression tests — advisory only

For changes to the evaluator, run its focused test with an isolated
`RAVI_STATE_DIR` from process startup; no install, full build or full suite is
needed:

```bash
bun test src/ci/review-gate.test.ts
```

Existing cases cover open/resolved/outdated threads, native independent human
approval, current/stale heads, API/pagination failures and finding dismissal
or renewal provenance. They test the evaluator's result, not the live branch
policy, key custody, signed attestation or dedicated-App enforcement. This
spec-only correction does not implement those recommended mechanisms.
