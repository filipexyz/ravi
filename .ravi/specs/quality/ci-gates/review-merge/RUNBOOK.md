---
id: quality/ci-gates/review-merge
title: "Review Merge Gate Runbook"
kind: feature
domain: quality
capability: ci-gates
feature: review-merge
status: active
---

# Review gate operations

## 1. Historical snapshot — do not reinstall it as current policy

Ruleset `26284495` was observed on 31/10 and is now absent. Its old settings are
preserved in `SPEC.md` for audit. `.github/review-gate-ruleset.json` is the
historical Actions-bound design; it MUST NOT be applied as the recommended
independent-App replacement. No mutation command is prescribed by this update.

## 2. Inspect the actual current policy

Use read-only inspection, with a timestamp:

```bash
gh api repos/filipexyz/ravi/rulesets
gh api repos/filipexyz/ravi/rules/branches/dev
gh api repos/filipexyz/ravi/rulesets/26284495
```

The last request returns 404 as of 01/11. Retain that as removal evidence;
do not recreate the id, search for an obsolete enforcement claim, or treat
404 as proof that the old guard still applies. Effective rules, not a checked-in
JSON file, determine which checks are currently required.

The 01/11 readback requires only `Quality Gate` as a status check in `dev`.
`Review Gate` / `Review Gate Tests` are advisory. A red advisory check may
provide useful findings, but the platform does not enforce its verdict. A
reproduced credential finding can therefore remain mergeable when the actual
required checks/platform conditions pass. Do not test that exposure by merging.

For an integration request, record the exact candidate, current rule readback,
review provenance and outstanding findings. Ravi's operating instruction is to
stop on missing independent review or an unresolved reproduced credential
finding. Report that stop honestly as a process decision, not an installed
GitHub veto. A session envelope under the author's principal is no waiver.

## 3. Prepare the recommendation for the policy owner

Luís (`filipexyz`) owns settings, rulesets, permissions and activation decisions.
Direction/main prepares the proposal in dedicated intelligence Threads. This
runbook does not authorize changes to those controls or new credentials.

The readiness packet must demonstrate:

1. Reviewer identity and attestation key custody outside the author's reach,
   including a signer that rejects author-originated requests to impersonate
   a reviewer; separate session labels alone fail this requirement.
2. A signed verdict bound to repository/PR/head/base/tree, contract/policy,
   findings, evidence digest, validity interval and reviewer authority.
3. A verifier and policy not supplied by mutable PR code, publishing through
   a dedicated GitHub App whose credential is unavailable to the author.
4. The concrete proposed required-check binding to that App, retained quality
   checks, candidate invalidation and review-state revalidation at integration.
5. The negative/positive cases from `CHECKS.md`, including advisory-only App
   output, same-principal envelope, forged Actions check and a reproduced
   credential finding. No experimental merge is necessary.

After an explicit owner decision and implementation by its authorized scope,
read back the actual rules/check publisher and record actor, time and evidence.
Only then can the recommendation be marked enforced. Until then, no claim of
restoration, automatic merge protection or substituted approval is valid.

## Existing evaluator diagnostics — advisory semantics only

`src/ci/review-gate.cjs` still evaluates native GitHub reviews. Its human-approval,
thread-resolution and technical-dismissal requirements describe its own result,
not current merge eligibility. Do not manufacture native approval or translate
an author session envelope into approval to obtain a green result.

Its historical dismissal format remains:

```text
review-gate-dismiss <full-current-head-sha>
Reason: <concrete technical reason, at least 20 characters>
```

A renewal on a new head references the original native dismissal event:

```text
review-gate-renew <original-dismissal-event-node-id> <full-current-head-sha>
Reason: <why the dismissal remains technically valid after this change>
```

These formats are evaluator inputs only. They are neither signed reviewer
attestations nor a substitute for the recommended independent-App boundary.
No findings are dismissed or reviews submitted as part of this documentation.
