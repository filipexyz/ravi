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

The initial policy required a second GitHub writer and was unsatisfiable with one collaborator. The operator replaced that requirement with recorded independent session review bound to the exact head SHA. Native writer approval becomes additional mandatory evidence when a second human writer exists; a one-line constant can force it unconditionally later. No collaborator is invited and no author session approves its own work.

A read-only `pull_request` workflow can be tested before merging the gate itself, with no deployment, secret or daemon restart. Session provenance is publisher-attested and can be forged by a malicious writer; it is not independent identity verification. A separately governed publisher and signed runtime attestations would strengthen that boundary and are not silently provisioned here.

PR #776 demonstrated two distinct holes: shell options counted as script arguments, and an issue-comment code blocker was absent from review evidence. It also showed that an advisory gate cannot enforce merge policy. Tests now preserve the code-blocked verdict across GitHub surfaces. The gate remains advisory; any promotion to required status is a separate operator decision, not a promised outcome of this fix.

The operator explicitly declined Checks write access. A read-only issue-comment workflow would report against the default-branch SHA and would not replace the PR check, so it is not presented as a fix. Binding verdicts use native PR reviews. Late issue-only blockers remain a documented stale-check window until another PR event/push; native review discipline is the accepted containment.
