---
id: quality/ci-gates/review-merge
title: "Review Merge Gate Checks"
kind: feature
domain: quality
capability: ci-gates
feature: review-merge
status: active
---

# Verification

Run `bun test src/ci/review-gate.test.ts` (no install, full build or full suite needed).

- Open thread + valid independent head approval: blocks.
- Resolved thread + valid independent head approval: passes.
- HTTP 403/429/500, network/GraphQL errors, malformed or incomplete response: blocks.
- New head with approval on old head: blocks. Previously resolved threads do not rescue it.
- Outdated unresolved thread, later changes requested, author/bot/reader approval: blocks.
- Missing/blank/self/stale/automatic finding dismissal: blocks.
- Justified independent dismissal: audit includes actor, reason, SHA and source URL; unresolved thread still blocks.
- New independent head approval explicitly renewing a justified dismissal: passes once resolved.
- Pagination to page two finds a blocker; malformed cursor or truncated count blocks.
- Head or evidence changes between reads: blocks.

On the PR, inspect `Review Gate Tests` and the live `Review Gate` logs. A live gate failure for missing independent approval is expected with one collaborator; never manufacture an approval to make the check green. Fixture success is not a live second-identity approval.

## Interim-state verification

- Read `gh api repos/filipexyz/ravi/rulesets/26284495` and
  `gh api repos/filipexyz/ravi/rules/branches/dev`. Compare with the dated
  snapshot in `SPEC.md`; an active ruleset with zero required approvals must
  be reported as reviewer requirement OFF, not fully enforced review.
- Confirm that required checks and conversation resolution are recorded
  independently from the reviewer requirement. Do not infer that the whole
  ruleset was disabled.
- For each attempted integration, require a current-head/base review packet,
  distinct authenticated author/reviewer principals, a fresh explicit verdict
  and no unresolved blocking findings. Rename, new session, stale candidate,
  absent evidence, unavailable reviewer or inconclusive verdict must block.
- An internal Astra approval must not turn a failed native human-approval
  evaluator into success. Preserve all still-required checks; do not fabricate
  approvals or substitute an internal artifact for a GitHub review.
- No claim that unattended internal enforcement is installed is valid without
  independent evidence of the merge path and credential boundary. This
  documentation change alone is not such evidence.
- The open exception must retain its owner, timestamp, observed state,
  residual risk and restoration criteria. Only fresh configuration evidence
  and the restoration checks below may close it.

## Restoration verification

Inspect the active ruleset by REST readback and `gh api repos/filipexyz/ravi/rules/branches/dev`. Both named checks must appear with integration 15368; at least one required approval, stale dismissal, last-push approval and conversation resolution must be enabled. Verify `bypass_actors` is empty. Check PR `reviewDecision`/`mergeStateStatus`; do not attempt a merge as a test.

Confirm that missing independent approval, approval on an old head and an
unresolved finding each remain blocking, while a current eligible approval
with resolved findings and passing checks is eligible. Record the actor,
timestamp and evidence before changing the exception to restored. Fixture
success alone does not prove live native enforcement.
