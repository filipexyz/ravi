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

This spec separates historical evidence, observed live enforcement and the
recommended replacement. Frontmatter `status: active` makes the documentation
normative; it does not mean that the recommended gate is deployed.

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

## 2. Current configured policy — 2026-11-01 observation

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

The existing evaluator may still reject missing independent human approval,
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
