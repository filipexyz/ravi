---
id: quality/ci-gates/review-merge
title: "Review Merge Gate Rationale"
kind: feature
domain: quality
capability: ci-gates
feature: review-merge
status: active
---

# Why this gate exists

PRs #767 and #756 were reported merged with unresolved security findings and without independent approvals. Successful build checks do not establish that review findings were addressed.

The API check supplies verifiable review evidence and a SHA-bound audit trail. Native GitHub rules supply enforcement at merge time, including changes to thread state that do not trigger Actions. Both are required: polling alone leaves stale success windows, and conversation resolution alone is not an independent review.

The policy intentionally blocks the current single-collaborator setup. As of initial rollout, `filipexyz` was the only collaborator and had admin access. A second GitHub identity with write access is needed to approve its PRs. We do not invite users or expand access as part of installing this gate.

A read-only `pull_request` workflow can be tested before merging the gate itself, with no deployment, elevated target workflow, secret or daemon restart. A writer can edit its definition; native independent review still prevents that writer from releasing its own change. An isolated check publisher would improve this boundary, but requires separately governed credentials/installation and is not silently provisioned here.
