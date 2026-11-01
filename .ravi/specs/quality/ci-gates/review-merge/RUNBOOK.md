---
id: quality/ci-gates/review-merge
title: "Review Merge Gate Runbook"
kind: feature
domain: quality
capability: ci-gates
feature: review-merge
status: active
---

# Policy and owners

Policy lives in this spec, `.github/workflows/review-gate.yml`, `src/ci/review-gate.cjs` and `.github/review-gate-ruleset.json`. Repository writers can propose changes; native review rules require another identity's approval. Repository admins (currently `filipexyz`) can change or remove rulesets. There is no organization administrator above the personal repository enforcing this configuration.

# Install and verify

Create an additive ruleset, preserving existing rulesets:

```bash
gh api --method POST repos/filipexyz/ravi/rulesets --input .github/review-gate-ruleset.json
gh api repos/filipexyz/ravi/rulesets/<returned-id>
gh api repos/filipexyz/ravi/rules/branches/dev
```

If the ruleset already exists, update its id with `--method PUT` instead of creating a duplicate. Save the pre-change response outside the repository first. No branch push, merge, deployment or service restart is involved.

The policy takes effect immediately. Until the workflow lands on `dev`, PRs without the workflow will wait for the required status checks. The gate's own PR runs the new workflow before merge. Do not weaken the rule to bootstrap it: obtain a real independent approval on its final SHA.

# Normal review

1. Address findings, push the code and resolve the corresponding threads.
2. Record author provenance in the PR body, before the first section (to avoid the PR-description placeholder check): `<!-- ravi-author {"agent":"builder","session":"build-session"} -->`.
3. A different session reviews the complete final diff and submits a **native PR review**, with this envelope in its body or review comment. Use real session/agent identifiers and a concrete rationale. `resolves` names exact finding URLs explicitly rechecked after their latest edit; leave it empty if there are none. Issue comments cannot carry approving verdicts. With the same GitHub account, submit a native `COMMENT` review, not GitHub self-`APPROVE`.

   `<!-- ravi-review {"head":"<full-current-head-sha>","agent":"reviewer","session":"review-session","authorSession":"build-session","verdict":"approved","reason":"<review rationale>","resolves":[]} -->`

4. If a second human writer exists, also obtain their native exact-head approval. A separate agent using the author's credentials can provide a session verdict, but is not a second GitHub identity. Neither an author-session verdict nor a native approval alone is sufficient.
5. Inspect the latest `Review Gate` result. API failure is a block, not a waiver. Fix credentials/service availability and rerun.
6. For a resolution without a triggering review event, rerun the gate in Actions. A stale event's head SHA cannot authorize a newer commit.

Publish through `POST /repos/<owner>/<repo>/pulls/<number>/reviews`, with `event: "COMMENT"`, `commit_id` equal to the reviewed full head SHA and `body` containing the envelope and findings. Build the payload in a JSON file and pass `gh api ... --input <file>`; do not interpolate review prose into a shell command. The reviewer publishes its own evidence; the author must not manufacture a reviewing session.

Residual explicitly accepted by the operator: a blocking **issue comment** posted after the last PR event does not invalidate the existing check by itself. `issues: read` only permits reading it. Binding verdicts therefore go in native reviews; every subsequent PR event/push reads issue comments again and refuses unresolved blockers. No `issue_comment` workflow, Checks write access or secret is added. Reopen this design only for a legitimate blocker that native review cannot express.

# Enforcement and the #776 incident

PR #776 merged with zero native reviews and an issue comment carrying an unresolved code blocker. The original evaluator would reject its absent native approval **if evaluated and required**, but never queried issue comments and could not see that blocker once an otherwise valid approval existed. The ruleset had an empty required-check list; neither a source-level gate nor an advisory failure enforced anything.

The workflow in #778 already had no path filter. PR #775's old check run preceded its introduction; PR #773 received a later event and did run it. Do not diagnose a missing historical check as a path filter without inspecting the workflow and event timestamps.

The operator has separately required `Quality Gate` on `dev`. `Review Gate` remains advisory; this PR does not promise or perform promotion to a required check. Read back effective branch rules before claiming merge protection. Do not change rulesets, permissions or collaborators as part of a parser fix. The existing ruleset JSON is the stronger native-writer template, not the single-writer deployment configuration; applying it unchanged would require a second GitHub reviewer.

# Explicit technical dismissal

An independent writer dismisses the native review with this message (replace the SHA and reason):

```text
review-gate-dismiss <full-current-head-sha>
Reason: <concrete technical reason, at least 20 characters>
```

GitHub records the event's actor, timestamp and URL. Resolve the thread after recording the reason. A separate current-head approval is still required. Length validates the presence of rationale, not its correctness; the independent reviewer remains accountable for its substance.

After another push, the old native event cannot be edited/re-dismissed. In a new approval review on the current head, explicitly renew it:

```text
review-gate-renew <original-dismissal-event-node-id> <full-current-head-sha>
Reason: <why the dismissal remains technically valid after this change>
```

An unjustified original dismissal cannot be laundered by renewal. Automatic invalidation of an old approval is not a technical dismissal of a finding.

For multiple dismissals, repeat the two-line renewal block in the same approval body (one single-line reason per event).

# Limits and rollback

Required checks accept the GitHub Actions app as publisher; they cannot distinguish two workflows publishing the same name. A separately governed GitHub App or organization required workflow is needed to resist publisher spoofing. Native review and conversation rules must stay enabled regardless.

Rollback changes the ruleset and gate together and requires an explicit operator decision. Removing a required check without its replacement reopens the original defect; do not automatically disable the policy to clear a blocked PR.

Official contracts: [protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches), [Actions events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows), [review dismissal audit fields](https://docs.github.com/en/graphql/reference/pulls#reviewdismissedevent).
