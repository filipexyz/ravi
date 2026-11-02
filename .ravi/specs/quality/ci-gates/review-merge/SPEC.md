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

This spec separates historical evidence, observed live enforcement and the
recommended replacement. Frontmatter `status: active` and `normative: true`
describe this documentation; they do not mean that the recommended gate is deployed.

## 1. Historical snapshot — 2026-10-31 only

At `2026-10-31T22:23:58Z`, REST readback for `filipexyz/ravi`, branch `dev`,
showed ruleset `26284495` (`dev review merge gate`) with:

| Control | State at that observation only |
| --- | --- |
| Ruleset enforcement | `active`; no bypass actors |
| Native minimum approvals | `required_approving_review_count=0` |
| Independent last-push approval | `require_last_push_approval=false` |
| Stale approval dismissal | Enabled |
| Conversation resolution | Required |
| `Review Gate` and `Review Gate Tests` | Required, integration `15368`, strict checks |

The ruleset then reported an update at `2026-10-31T19:21:43.584-03:00`.
This was the evidence for exception `RG-2026-10-31-REVIEWER-OFF`. It is retained
as history, not as current configuration or as a guard still protecting merges.
The later removal below expands the enforcement gap; it does not close the
exception. The checked-in `.github/review-gate-ruleset.json` represents the
old design, not live state and not the recommended replacement to apply.

## 2. Configured policy — 2026-11-01, rechecked 2026-11-02

Read-only API inspection at `2026-11-01T13:15:45Z`, followed by the direct
historical-ruleset lookup in the same inspection, confirmed:

- `GET repos/filipexyz/ravi/rulesets/26284495` returns **404**.
- The remaining rulesets are `18436907` (`block main`), `18533706`
  (`dev copilot`) and `18436625` (`main`).
- `GET repos/filipexyz/ravi/rules/branches/dev` lists **only `Quality Gate`**
  in `required_status_checks`, with strict checking disabled. It also lists
  Copilot code review and code-quality rules; these are not an independent
  approval requirement or an enforcement of every review finding.
- `Review Gate` and `Review Gate Tests` are **not required in dev**. Their
  outputs, when produced, are advisory. No required review/last-push approval
  or conversation-resolution rule appears in this effective-rules readback.

The same read-only endpoints were rechecked on 2026-11-02 (inspection recorded
at `2026-11-02T14:32:31Z`) with the same results. PR #783 targets
`fix/review-merge-gate`, whose effective-rules endpoint returned `[]`; the
`dev` snapshot MUST NOT be presented as that stacked branch's rules.

The existing evaluator rejects missing independent native approval,
open threads or API failures when it runs. An evaluator failure is not a
repository merge veto unless its check is required. Conversely, its presence
in this branch, an old ruleset JSON or a prior successful run proves no live
protection. Configuration MUST be re-read before claiming a later state.

**Consequence:** a PR with a reproduced credential finding can be merged when
`Quality Gate` and other applicable platform conditions permit it; no currently
required review check makes that finding a blocker. A separate test might
happen to fail, but the system does not guarantee that. This documents an
exposure, not permission to merge the finding or a claim that such a merge
was performed during this inspection.

The intended internal review procedure is not independently enforced tooling.
This spec MUST NOT claim that a procedural instruction, attended merge,
agent verdict or session envelope compensates for the missing repository gate.

### Implemented approval contract — how the evaluator passes

`src/ci/review-gate.cjs` (`independentWriter` and `evaluate`) accepts at least
one native GitHub pull-request review meeting **all** of these conditions:

- The reviewer is a GraphQL `User`, with a login different from the PR author
  (case-insensitive), and permission `write`, `maintain` or `admin` according
  to the collaborator-permission API. Bots and read-only users do not count.
- That user's latest submitted review other than `COMMENTED` is `APPROVED`;
  pending reviews are ignored. A later `CHANGES_REQUESTED` or `DISMISSED`
  review supersedes their approval.
- The review's `commit.oid` equals the **full current head SHA** being
  evaluated. A new commit requires a new approval even if its tree is equal.

This is account/permission independence from the **PR author**, not a check
against the last pusher or proof of human identity, key custody or independent
control of two accounts. The evaluator does not implement the signed
head/base/tree attestation recommended below.

Approval alone is insufficient: the PR must be open and non-draft, every
review thread must be resolved (including outdated threads), and no reviewer's
latest substantive review may remain `CHANGES_REQUESTED`. Manually dismissed
findings need the independent, justified current-head dismissal or renewal
described in `RUNBOOK.md`. API failures, incomplete/inconsistent evidence or a
head change fail the run; before success, it rereads all review evidence.

The supported approval path is that eligible reviewer submitting a native
`APPROVE` review, through GitHub's UI or its pull-request reviews API, on the
reviewed head. There is **no implemented alternative approval input** for a
session envelope, review comment, artifact, signature or Git Data API
publication with a verified tree. Git Data API publication is a sanctioned
commit-publication procedure, not review approval. The replacement below
remains a proposal. See `RUNBOOK.md` for the exact native API request.

## 3. Recommendation and exit criteria — not deployed

The independent audit reported on 2026-11-01 concluded that replacing approval
with a session envelope from the **same authority principal is a bypass**, not
implementation of the exception. A second thread, session, model, display name
or agent identifier does not establish independence when the author controls
its credentials, signing capability or attestation issuer.

The replacement MUST establish both boundaries:

1. **Independent signed attestation.** An authorized reviewer produces a
   verdict signed by a key outside the author's reach. PR code, author tools
   and author-controlled sessions MUST NOT read that private key, impersonate
   the reviewer, change the trust store, or obtain arbitrary signatures from
   the signer. A signing service MUST authenticate the review authority and
   validate the verdict source rather than signing an author-supplied envelope.
2. **Required check from a dedicated GitHub App.** A verifier outside the
   author's mutable PR execution publishes the result through a separately
   controlled GitHub App. Effective branch rules MUST require that check and
   bind it to that App's identity. A same-named GitHub Actions check, or an App
   check left advisory, MUST NOT satisfy this boundary. The author's execution
   MUST NOT hold the App's check-writing credentials or alter its policy.

An attestation MUST bind repository, PR, exact head/base SHAs, candidate tree,
contract/policy version, reviewer authority, findings and dispositions,
evidence digest, explicit verdict and validity interval. Verification MUST
reject tampering, untrusted signatures, wrong subject, stale/replayed approval,
missing evidence and unresolved blocking findings. A reproduced credential
finding MUST block until independently verified resolution or a justified,
independently attested disposition. Renaming a finding or session is not a
resolution. Any technical dismissal MUST preserve actor, justification,
candidate and source evidence.

The check MUST fail closed when the reviewer, signer, verifier or evidence is
unavailable. It MUST invalidate stale results when the candidate or review
state changes and verify the current subject at integration. The final design
MUST cover changes that do not trigger the existing Actions workflow; cached
success is not permanent authorization. Quality checks remain separate and
required. Astra remains the model for cognitive review in its own Thread/task,
but model choice and session provenance are not signing authority.

### Ownership and closure

- **Luís (`filipexyz`) owns the repository-policy decision and any activation.**
  Direction/main prepares evidence and tracks the open gap. This documentation
  update authorizes no settings/ruleset changes, new permissions, collaborator
  invitations, credentials or App installation.
- The owner must approve the concrete replacement and its authority boundaries
  before activation. Reapplying the old Actions-bound JSON, restoring its old
  id, or accepting a same-principal envelope MUST NOT be called completion of
  the recommended independent gate.
- Exit requires independent verification of key custody and signer access,
  trusted verifier deployment, effective required-check binding to the App,
  retained `Quality Gate`, and all negative/positive cases in `CHECKS.md`.
  No bypass path available to the author may defeat these controls.
- Record the authorized actor, time, effective rule/check/App identities and
  validation evidence before declaring the gap closed. An admin's ability to
  reconfigure policy remains an explicit governance limit; do not claim
  resistance to the repository owner.
- Until those criteria are proven, the gate remains **recommended, not
  enforced**. Ravi agents MUST not use the missing gate as permission to merge
  unreviewed work or a reproduced unresolved credential finding. This is an
  operating instruction, not a claim of technical prevention.
