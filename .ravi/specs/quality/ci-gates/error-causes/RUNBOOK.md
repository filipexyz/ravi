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

PR runs use `GITHUB_BASE_REF`; push runs use `ERROR_CAUSE_BASE_REF` from the GitHub event's previous SHA. `ERROR_CAUSE_HEAD_REF` also checks the previous head history, preventing reintroductions within the first PR that adds the gate. Missing base refs and malformed baseline JSON fail closed.
