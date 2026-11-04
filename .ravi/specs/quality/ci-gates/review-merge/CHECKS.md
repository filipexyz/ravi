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
- Timeline count 12 with 10 visible nodes and `hasNextPage=false`: passes with an audit of both counts and difference 2. The same counts with `hasNextPage=true` and a repeated cursor: blocks.
- Timeline overcount across multiple complete pages: passes. Empty nonterminal pages, empty cursors, null/duplicate ids (including across pages), excess nodes, changing counts or more than 1000 pages: block.
- Timeline overcount with an unresolved thread or missing current-head approval: still blocks for the policy reason and reports the count difference.
- Review/review-thread overcounts: still block. Timeline count changes between final evidence reads: block even when the visible nodes are identical.
- Head or evidence changes between reads: blocks.

On the PR, inspect `Review Gate Tests` and the live `Review Gate` logs. A live gate failure for missing independent approval is expected with one collaborator; never manufacture an approval to make the check green. Fixture success is not a live second-identity approval.

Inspect the active ruleset by REST readback and `gh api repos/filipexyz/ravi/rules/branches/dev`. Both named checks must appear with integration 15368; required approvals, stale dismissal, last-push approval and conversation resolution must be enabled. Verify `bypass_actors` is empty. Check PR `reviewDecision`/`mergeStateStatus`; do not attempt a merge as a test.
