---
id: quality/ci-gates/error-causes
title: Error Cause Ratchet Runbook
kind: feature
domain: quality
capability: ci-gates
feature: error-causes
status: active
---

# Runbook

Run `bun scripts/error-cause-scan.ts` for the blocking check. The command reads source and Git objects only; it does not import Ravi runtime code or access its databases.

After correcting a masking site, run `bun scripts/error-cause-scan.ts --update` and review the shrinking baseline plus generated inventory. When an exception intentionally has no diagnostic consequence, write an adjacent `// no-cause: <specific explanation>` that names the fallback/cleanup behavior. Generic TODO, ignored, expected and legacy labels are not accepted reasons.

`--bootstrap` creates the initial baseline only when neither baseline file exists, always from the hardcoded initial commit. It is not a reset or refresh command. Do not change the original ceiling to make a new violation pass.

CI sets `ERROR_CAUSE_BASE_REF` to `pull_request.base.sha` for PRs and `event.before` for pushes. Local runs fall back to `origin/$GITHUB_BASE_REF` or `origin/dev`. Never use `pull_request.synchronize.before`: it is an old source head that may no longer be reachable. `ERROR_CAUSE_HEAD_REF` also checks the previous head history, preventing reintroductions within the first PR that adds the gate. Missing base refs and malformed baseline JSON fail closed.

The immutable anchor is not an ancestor of `dev`; its `error-cause-baseline` tag must remain on the remote. CI explicitly runs `git fetch --no-tags origin refs/tags/error-cause-baseline:refs/tags/error-cause-baseline` after checkout. `actions/checkout@v5` with `fetch-depth: 0` already fetches all tags, but making this particular dependency explicit gives a direct failure if the tag is missing. Setting `fetch-tags: true` alone does not change the full-history fetch path.

When a ref cannot be resolved, fetch full history and the anchor tag, and check that the event selected a reachable comparison base. Do not replace the anchor or edit either baseline JSON to repair the checkout. A rerun keeps the original event and workflow revision: rerun an old failure only to verify changes in available remote refs, not to claim validation of a newer workflow.
