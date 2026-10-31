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

- The workflow MUST run for every PR without path/branch filters or conditional skips. A workflow introduced after an older PR's last event MUST NOT be described as already evaluated on that PR; update the branch from the base and trigger a fresh PR event.
- `Review Gate` remains advisory until the operator verifies reporting and a real green PR under the current contract, then promotes it to a required check. A gate at the boundary without enforcement is decoration: source code, a green build or an advisory failure cannot prevent a merge. Missing enforcement MUST be reported explicitly, not inferred from a workflow's presence. PR #776 is the regression case.
- The evaluator MUST query GitHub's API, paginate every thread, review, issue-comment, timeline and collaborator page, and verify head SHA, explicit connection counts, nodes and pagination. HTTP/network/auth/GraphQL errors, nulls, partial results and inconsistent snapshots MUST fail closed. An explicit complete zero-thread result is valid; absence of data is not.
- Every unresolved review thread MUST block, including outdated threads. Neither a green build, a dismissed review nor a severity label waives an open thread.
- A successful evaluation MUST have a structured review verdict for the exact head SHA, published by a writer, with recorded reviewer agent/session, author session, rationale and GitHub evidence URL/timestamp. The reviewer session MUST differ from the author session declared in the PR body. The GitHub publisher MAY be the same account in a single-writer repository; the author's own session MUST NOT approve itself. Missing/malformed provenance, reader publication and stale verdicts MUST fail closed.
- Native `APPROVED` review is an additional mandatory signal when the collaborator inventory contains a second human writer. It MUST be the latest effective approval by a non-author writer on the exact head SHA. Without a second writer, independent session review is sufficient. `REQUIRE_NATIVE_WRITER_APPROVAL = true` MUST force native approval even without a second writer; changing this policy is a one-line explicit decision. Native approval alone MUST NOT replace the session verdict.
- A literal `blocked-por-código` (or unaccented spelling) in a PR body, native review body or issue comment MUST block just like an unresolved thread, including when a same-SHA check was previously green. Ordinary approval MUST NOT silently waive it. Resolution requires an explicit evidence URL in a newer current-head independent session verdict, with rationale; an edited blocker invalidates an older resolution. A blocker in the PR body must be removed from the body. Edits/deletions MUST be re-evaluated against current API evidence.
- A push MUST invalidate the old approval and the attestation of previously resolved findings. A fresh independent session verdict on the new head is required even when GitHub retains the thread's resolved bit.
- The gate MUST re-read the head and all evidence before success. Changing head or review evidence during evaluation MUST fail, requiring another run.
- A manually dismissed review carrying a finding MUST have a native `ReviewDismissedEvent` with independent actor, technical justification, timestamp, URL and explicit SHA. The thread MUST also be resolved and there MUST still be an independent approval. Empty/generic unstructured dismissal messages MUST NOT qualify.
- A stale dismissal can only be renewed by a new independent approval on the new SHA explicitly referencing the original dismissal event with a fresh justification. Native automatic dismissal of stale approvals is not a finding waiver.
- Tests MUST cover open/resolved/API-failure/new-push scenarios independently of live credentials, plus same-SHA green-to-blocked issue comments, edited/deleted comments, self-session refusal, stale verdicts and conditional native approval.

## Trust boundary

The PR workflow executes PR code with read-only GitHub permissions and installs no project dependencies. It MUST NOT receive write credentials or repository secrets. It is reviewable repository policy, not an independently administered GitHub App.

Agent/session provenance is an authenticated publisher's attestation. It is not cryptographic proof that two strings represent separate executions: a writer able to forge author/reviewer metadata can forge this evidence. This policy prevents accidental self-review within the operator-controlled workflow, not a malicious repository writer. Independent review must actually be performed by the named session.

Binding a required check to GitHub Actions does **not** bind it to a particular workflow file. A writer can propose a workflow that reports the same name. Administrators can edit the ruleset itself. Stronger guarantees against malicious writers or the repository owner require independently administered provenance, a GitHub App/required workflow and organization-level policy. Do not claim those guarantees exist here.

GitHub Actions has no `pull_request_review_thread` trigger. Native conversation-resolution rules remain the protection against cached success after a thread is reopened. After resolving a thread, re-run the failed gate on the current PR commit (or submit the final current-head review). Do not claim native enforcement is active without reading back the live rules.
