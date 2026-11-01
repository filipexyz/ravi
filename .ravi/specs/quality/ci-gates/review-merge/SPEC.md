---
id: quality/ci-gates/review-merge
title: "Review Merge Gate"
kind: feature
domain: quality
capability: ci-gates
feature: review-merge
status: active
normative: true
applies_to:
  - src/ci/review-gate.cjs
  - src/ci/review-gate.test.ts
  - .github/workflows/review-gate.yml
  - .github/review-gate-ruleset.json
---

# Review Merge Gate

## Contract

- `Review Gate` and `Review Gate Tests` MUST be required checks on `dev`, bound to the GitHub Actions integration (15368). The additive ruleset MUST have no bypass actors.
- The platform MUST require a PR, one independent approval, stale approval dismissal on push, approval of the last push by another identity, and resolution of all conversations. Missing checks MUST block merging.
- The evaluator MUST query GitHub's API, paginate every thread, review and timeline page, and verify head SHA, explicit counts, nodes and pagination. HTTP/network/auth/GraphQL errors, nulls, partial results and inconsistent snapshots MUST fail closed. An explicit complete zero-thread result is valid; absence of data is not.
- Every unresolved review thread MUST block, including outdated threads. Neither a green build, a dismissed review nor a severity label waives an open thread.
- A successful evaluation MUST have a latest effective `APPROVED` review by a non-author human identity with current write/maintain/admin access, whose review commit equals the event's exact head SHA. Bots, the PR author and reader approvals MUST NOT qualify.
- A push MUST invalidate the old approval and the attestation of previously resolved findings. A fresh independent approval on the new head is required even when GitHub retains the thread's resolved bit.
- The gate MUST re-read the head and all evidence before success. Changing head or review evidence during evaluation MUST fail, requiring another run.
- A manually dismissed review carrying a finding MUST have a native `ReviewDismissedEvent` with independent actor, technical justification, timestamp, URL and explicit SHA. The thread MUST also be resolved and there MUST still be an independent approval. Empty/generic unstructured dismissal messages MUST NOT qualify.
- A stale dismissal can only be renewed by a new independent approval on the new SHA explicitly referencing the original dismissal event with a fresh justification. Native automatic dismissal of stale approvals is not a finding waiver.
- Tests MUST cover open/resolved/API-failure/new-push scenarios independently of live credentials.

## Trust boundary

The workflow executes PR code with read-only GitHub permissions and installs no project dependencies. It MUST NOT receive write credentials or repository secrets. It is reviewable repository policy, not an independently administered GitHub App.

Binding a required check to GitHub Actions does **not** bind it to a particular workflow file. A writer can propose a workflow that reports the same name, but still cannot self-approve the required native review. Administrators can edit the ruleset itself. Stronger guarantees against a malicious writer plus colluding reviewer, or against the repository owner, require a separately governed GitHub App/required workflow and organization-level policy. Do not claim these guarantees exist in a personal repository.

GitHub Actions has no `pull_request_review_thread` trigger. Native conversation-resolution and review rules MUST remain enabled to prevent a cached success from permitting merge after a thread is reopened or an approval is dismissed. After resolving a thread, re-run the failed gate on the current PR commit (or submit the final current-head approval).
