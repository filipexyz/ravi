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
- A code-blocked issue comment posted after green on the same SHA: blocks; editing or deleting it triggers a fresh decision.
- The same blocker in a PR body or native review body: blocks even with valid approval.
- Author-session verdict, old-SHA verdict, missing provenance and reader publication: blocks.
- Single-writer repo plus valid different-session current-head verdict: passes when all findings are resolved.
- Second writer present: native approval and session verdict are both required.
- Explicit URL resolution must be newer than the blocker; a subsequent blocker edit invalidates it.
- The workflow must have no path/branch filters; old PRs predating the workflow need a fresh event.

On the PR, inspect `Review Gate Tests` and the live `Review Gate` logs. Missing real session review must remain red; never invent provenance to make it green. A separate reviewing session must actually read the diff and publish its verdict.

Inspect the active ruleset by REST readback and `gh api repos/filipexyz/ravi/rules/branches/dev`. Report actual required checks and native review/conversation settings. The operator promotes Review Gate only after a live green PR. Until then it is advisory. Do not attempt a merge as a test or silently install the stronger native-writer template.
