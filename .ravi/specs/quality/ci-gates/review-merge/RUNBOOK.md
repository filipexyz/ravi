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

Policy lives in this spec, `.github/workflows/review-gate.yml`, `src/ci/review-gate.cjs` and `.github/review-gate-ruleset.json`. The JSON file is the restoration target, not a snapshot of current settings. Repository writers can propose changes; native independent approval is currently OFF under `RG-2026-10-31-REVIEWER-OFF`. Repository admins (currently `filipexyz`) can change or remove rulesets. There is no organization administrator above the personal repository enforcing this configuration.

# While the reviewer requirement is OFF

1. Direction/main collects the independent Astra review artifact, canonical
   author/reviewer identities, exact head/base SHAs, contract, findings and
   verification evidence. A different session under the author's agent is
   not an independent reviewer. Evaluation occurs in its own Thread/task.
2. Read the effective configuration before any integration attempt:

   ```bash
   gh api repos/filipexyz/ravi/rulesets/26284495
   gh api repos/filipexyz/ravi/rules/branches/dev
   ```

3. Compare the candidate and review evidence immediately before integration.
   Preserve every required check and conversation rule. The internal review
   artifact does not make the unchanged human-approval evaluator pass; a
   failed or missing `Review Gate` still blocks the authorized path.
4. Keep unattended agent merges blocked until a separately enforced internal
   integration path is implemented and independently verified. A maintainer
   can perform an attended merge only when the full packet and every live
   requirement are satisfied. Do not use a merge attempt as a gate test.
5. Keep the exception open and visible to its restoration owner, Luís
   (`filipexyz`). Missing reviewer/evidence is a blocker, not approval by
   timeout. Do not disable another check to make this procedure complete.

# Restore the requirement

Luís owns the repository change; Direction/main prepares the evidence. Do not
invite collaborators, expand permissions, provision credentials or switch to
a different approval policy implicitly.

1. Establish a real independent reviewer eligible for the existing native
   evaluator and verify a fresh approval on the exact candidate. An Astra
   review under the author's GitHub account does not qualify.
2. Save the current ruleset response, preserve unrelated rules, and have the
   owner or explicit delegate restore at least one required approval and
   `require_last_push_approval=true` on the existing ruleset. The installation
   commands below describe mutation; this runbook update does not apply them.
3. Verify effective rules, empty bypass actors, required check publishers,
   stale dismissal and conversation resolution. Exercise missing approval,
   stale candidate, unresolved finding and eligible approval scenarios through
   checks/readback, without an experimental merge.
4. Update the exception in `SPEC.md` with restored state, actor, timestamp and
   evidence. Close it only after readback and verification. A planned change,
   active ruleset label or successful unit test is insufficient.

# Install and verify

Create an additive ruleset, preserving existing rulesets:

```bash
gh api --method POST repos/filipexyz/ravi/rulesets --input .github/review-gate-ruleset.json
gh api repos/filipexyz/ravi/rulesets/<returned-id>
gh api repos/filipexyz/ravi/rules/branches/dev
```

If the ruleset already exists, update its id with `--method PUT` instead of creating a duplicate. Save the pre-change response outside the repository first. No branch push, merge, deployment or service restart is involved.

The policy takes effect immediately when applied. Until the workflow lands on `dev`, PRs without the workflow will wait for the required status checks. The gate's own PR runs the new workflow before merge. Do not weaken the rule to bootstrap it: obtain a real independent approval on its final SHA. The operator's recorded temporary exception is not permission for additional automatic weakening.

# Normal review

1. Address findings, push the code and resolve the corresponding threads.
2. Have a second human GitHub identity with write/maintain/admin permission approve the exact current head. A separate agent using the author's GitHub credentials is not a second identity.
3. Inspect the latest `Review Gate` result. API failure is a block, not a waiver. Fix credentials/service availability and rerun.
4. For a resolution without a triggering review event, rerun the gate in Actions. A stale event's head SHA cannot authorize a newer commit.

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

Required checks accept the GitHub Actions app as publisher; they cannot distinguish two workflows publishing the same name. A separately governed GitHub App or organization required workflow is needed to resist publisher spoofing. The restored contract requires native review and conversation rules; during the recorded exception, do not claim that the missing native approval boundary is still enforced.

Rollback changes the ruleset and gate together and requires an explicit operator decision. Removing a required check without its replacement reopens the original defect; do not automatically disable the policy to clear a blocked PR.

Official contracts: [protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches), [Actions events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows), [review dismissal audit fields](https://docs.github.com/en/graphql/reference/pulls#reviewdismissedevent).
