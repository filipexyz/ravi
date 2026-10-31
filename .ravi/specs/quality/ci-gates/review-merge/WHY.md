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

The initial policy intentionally blocked the single-collaborator setup. As of initial rollout, `filipexyz` was the only collaborator and had admin access. A second GitHub identity with write access is needed to approve its PRs. This historical observation is not a fresh collaborator inventory. We do not invite users or expand access as part of installing this gate.

A read-only `pull_request` workflow can be tested before merging the gate itself, with no deployment, elevated target workflow, secret or daemon restart. A writer can edit its definition; when enabled, native independent review prevents that writer from releasing its own change. An isolated check publisher would improve this boundary, but requires separately governed credentials/installation and is not silently provisioned here.

## 2026-10-31 decision: explicit temporary reviewer-off interval

The operator reported needing to disable mandatory reviewers temporarily.
Readback confirmed zero required approvals and no last-push approval in the
`dev review merge gate` ruleset, while required gate checks and conversation
resolution remained enabled. `SPEC.md` records the exact observation and
exception `RG-2026-10-31-REVIEWER-OFF`.

The decision is to keep independent review mandatory in Ravi's own process,
without pretending that a policy document is an installed enforcement tool.
Unattended integration waits for a verified internal enforcement path;
attended integration still needs a complete independent review packet and all
currently required checks. The native evaluator's independent human approval
contract is unchanged: an agent verdict must not be passed off as that approval.

The accepted temporary limitation is weaker prevention of an out-of-process
merge, not permission to skip review. The native second-identity barrier and
its protection against a writer spoofing an Actions check are absent. Keeping
the OFF state, owner and exit criteria visible prevents the disabled guard
from silently becoming the permanent design.

Luís, as repository administrator, owns restoration. Direction/main owns the
readiness packet and operational follow-through, using a dedicated Thread
for each decision. Restoration needs a usable independent approval path and
effective-rule readback, not just a workflow merge or a green fixture test.
No deadline or new access grant was supplied by the operator; neither is
invented here. Every attempted integration is a mandatory revalidation point.
