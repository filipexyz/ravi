---
id: quality/ci-gates/review-merge
title: "Review Merge Gate Runbook"
kind: feature
domain: quality
capability: ci-gates
feature: review-merge
status: active
---

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

The last request returns 404 as of 01/11, reconfirmed on 02/11. Retain that as removal evidence;
do not recreate the id, search for an obsolete enforcement claim, or treat
404 as proof that the old guard still applies. Effective rules, not a checked-in
JSON file, determine which checks are currently required.

The 01/11 readback requires only `Quality Gate` as a status check in `dev`.
`Review Gate` / `Review Gate Tests` are advisory. A red advisory check may
provide useful findings, but the platform does not enforce its verdict. A
reproduced credential finding can therefore remain mergeable when the actual
required checks/platform conditions pass. Do not test that exposure by merging.

For a stacked PR, also inspect its actual base with
`gh api repos/filipexyz/ravi/rules/branches/<URL-encoded-base-branch>`.
On 02/11, #783's base `fix/review-merge-gate` returned `[]`; it does not inherit
the `dev` readback above.

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

## Existing evaluator — satisfy native approval, then inspect every blocker

`src/ci/review-gate.cjs` still evaluates native GitHub reviews. Its native-approval,
thread-resolution and technical-dismissal requirements describe its own result,
not current merge eligibility. Do not manufacture native approval or translate
an author session envelope into approval to obtain a green result.

For `No independent writer approval on head SHA <sha>`:

1. Read the PR's current full head SHA and author. An eligible reviewer must be
   a different GitHub `User` with `write`, `maintain` or `admin` permission.
   Review the actual diff at that SHA, including findings and dispositions.
2. That reviewer submits a native **Approve** review in GitHub, or the request
   below using their own authorized identity. The gate ignores comments and
   pending reviews; the reviewer's latest substantive review must be
   `APPROVED` with `commit.oid` equal to the current head.
3. Inspect the resulting run's evaluated SHA and all blockers. A new head
   needs fresh approval even for an identical tree. Draft status, unresolved
   threads (including outdated ones), outstanding `CHANGES_REQUESTED`, invalid
   dismissals and incomplete/API-failed evidence still prevent success.

Native review submission through the API is the same approval mechanism, not
an alternate attestation. The reviewer substitutes the PR number and reviewed
40-character head SHA before running this request:

```bash
gh api --method POST repos/filipexyz/ravi/pulls/<number>/reviews \
  -f commit_id='<full-reviewed-head-sha>' \
  -f event=APPROVE \
  -f body='Reviewed this exact head and the disposition of its findings.'
```

No second eligible reviewer means this evaluator cannot pass legitimately.
Another agent/session under the author's login, a `COMMENTED` review or a
review artifact does not supply approval. Publishing commits through the
sanctioned Git Data API procedure with matching commit/tree objects also does
not create a native review. No signed-attestation verifier or alternative
approval reader exists in this implementation; section 3 remains proposed.

For #783, keep draft as requested. Its 01/11 run on `910b8d5` reported draft,
missing independent approval and an unresolved outdated thread. A docs edit
does not clear those states, and no draft promotion, resolution, dismissal or
approval is performed by this documentation task.

The workflow subscribes to PR, review and review-comment events listed in
`.github/workflows/review-gate.yml`; it has no dedicated thread-resolution
trigger. After a state-only change, check for a fresh evaluation rather than
treating cached success as current authorization. A rerun tied to an obsolete
head fails the evaluator's head check.

### Native finding dismissal and renewal

The implemented dismissal format is entered as the native review dismissal
message by an independent writer, with at least 20 characters of reason:

```text
review-gate-dismiss <full-current-head-sha>
Reason: <concrete technical reason, at least 20 characters>
```

A renewal on a new head goes in the body of a **new native approved review**
by an independent writer on that head. It references the original native
dismissal event's node id and has a single-line reason of at least 20 characters:

```text
review-gate-renew <original-dismissal-event-node-id> <full-current-head-sha>
Reason: <why the dismissal remains technically valid after this change>
```

These formats are evaluator inputs only. They are neither signed reviewer
attestations nor a substitute for the recommended independent-App boundary.
Dismissal/renewal never resolves an open thread or waives the native approval
requirement. No findings are dismissed or reviews submitted as part of this documentation.
