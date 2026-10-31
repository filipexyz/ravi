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

## Current operational state: reviewer requirement OFF

Exception `RG-2026-10-31-REVIEWER-OFF` is open. On 2026-10-31 the operator
reported temporarily disabling mandatory reviewers. REST readback at
`2026-10-31T22:23:58Z` confirmed the following for `filipexyz/ravi`, branch
`dev`, ruleset `26284495` (`dev review merge gate`):

| Control | Observed state |
| --- | --- |
| Ruleset enforcement | `active`; no bypass actors |
| Native minimum approvals | **OFF**: `required_approving_review_count=0` |
| Independent last-push approval | **OFF**: `require_last_push_approval=false` |
| Stale approval dismissal | Enabled |
| Conversation resolution | Required |
| `Review Gate` and `Review Gate Tests` | Still required, integration `15368`, strict checks |

The ruleset was last updated at `2026-10-31T19:21:43.584-03:00`. Evidence is
the operator instruction plus read-only GETs of
`repos/filipexyz/ravi/rulesets/26284495` and
`repos/filipexyz/ravi/rules/branches/dev`. This is a dated snapshot, not a
claim about other branches or future configuration. Frontmatter `status:
active` describes this policy, not completion of its enforcement rollout.

### Interim decision and accepted boundary

- Independent review MUST remain mandatory in Ravi's own process while the
  native reviewer requirement is off. CI success or a merge button being
  available MUST NOT authorize a merge.
- Direction/main owns collection of the review packet and operational
  tracking of this exception. Each cognitive evaluation MUST run in its own
  Thread with `codex/gpt-6-astra`, linked to the durable delivery/review task.
  The reviewer MUST be a distinct authenticated agent principal and execution
  from every patch contributor; a renamed session or another thread under the
  author's principal MUST NOT count as independence.
- The packet MUST identify the PR, exact head/base SHAs, contract version,
  authors/contributors, reviewer identity and thread, explicit verdict,
  resolved findings and verification evidence. A change to the candidate or
  relevant review evidence MUST invalidate that packet before integration.
- This documentation does NOT install an internal technical enforcement
  service or isolate merge credentials. Until such a path is implemented and
  independently verified, unattended agent merges MUST remain blocked. A
  maintainer MAY perform an attended merge only after checking the independent
  review packet, fresh repository evidence and every still-required check.
- The existing evaluator still requires an eligible independent **human
  GitHub approval**. An Astra review artifact is additional internal evidence,
  not a substitute for that approval and not permission to waive a failing
  `Review Gate`. Missing reviewer, missing evidence, inconclusive review or
  failed/missing required checks MUST block the authorized integration path.
- The temporary risk is loss of the native second-identity/last-push barrier.
  A writer or administrator using another path may bypass the internal
  procedure; the current Actions check publisher is not independent of PR
  authors, and a previous success is not a permanent authorization. Existing
  required checks and conversation rules reduce some risks but MUST NOT be
  described as equivalent protection. This exception does NOT authorize
  unreviewed merges, fabricated approvals, weakened remaining checks, hook
  bypasses or additional permissions.

### Restoration ownership and exit criteria

- **Accountable restoration owner: Luís (`filipexyz`), repository admin.**
  Direction/main prepares the readiness evidence and keeps the exception
  visible; the owner applies or explicitly delegates the repository change.
- Before each attempted integration while this exception is open, the
  integration owner MUST refresh the rules readback and review packet. Missing
  evidence MUST stop the attempt; silence or elapsed time MUST NOT close the
  exception.
- Restore the native requirement once a real independent eligible reviewer
  is available and the current-head gate can be exercised without inventing
  approval or expanding access implicitly. A separately governed internal
  gate may be proposed as a replacement only by an explicit policy decision;
  it MUST NOT silently replace the current human-approval evaluator.
- Restoration MUST set the minimum approval count back to at least one and
  require independent last-push approval, retain all other required controls,
  verify the effective branch rules and the negative/positive scenarios in
  `CHECKS.md`, and record actor, time and evidence here. A fixture pass, merged
  workflow or active ruleset label alone MUST NOT mark this exception closed.

## Required restored-state contract

- `Review Gate` and `Review Gate Tests` MUST be required checks on `dev`, bound to the GitHub Actions integration (15368). The additive ruleset MUST have no bypass actors.
- The restored platform state MUST require a PR, one independent approval, stale approval dismissal on push, approval of the last push by another identity, and resolution of all conversations. Missing checks MUST block merging. The two approval requirements are currently off under the recorded exception above; this target MUST NOT be reported as the live state.
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

Binding a required check to GitHub Actions does **not** bind it to a particular workflow file. A writer can propose a workflow that reports the same name. When the native approval requirement is enabled, that writer still cannot self-approve the required native review. That safeguard is currently absent under the recorded exception. Administrators can edit the ruleset itself. Stronger guarantees against a malicious writer plus colluding reviewer, or against the repository owner, require a separately governed GitHub App/required workflow and organization-level policy. Do not claim these guarantees exist in a personal repository.

GitHub Actions has no `pull_request_review_thread` trigger. The restored state MUST keep native conversation-resolution and review rules enabled to prevent a cached success from permitting merge after a thread is reopened or an approval is dismissed. During the exception, fresh attended evidence checks are required but MUST NOT be described as equivalent server-side enforcement. After resolving a thread, re-run the failed gate on the current PR commit (or submit the final current-head approval).
