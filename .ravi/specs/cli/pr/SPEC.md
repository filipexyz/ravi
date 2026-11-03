---
id: cli/pr
title: "Verified PR publication"
kind: capability
domain: cli
capabilities:
  - pr
tags:
  - cli
  - github
  - watch
  - write-brake
applies_to:
  - src/cli/commands/pr.ts
  - src/pr
  - src/hooks/gh-pr-publish.ts
  - src/cli/remote-gateway.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Verified PR publication

`ravi pr publish` uploads the current committed branch through Git Data API,
creates or reuses its ready PR, and reconciles CI follow. Upload, verification,
PR reconciliation and follow are internal helpers, not separate public commands.

## Contract

- `--repo owner/repo` and `--base branch` are required. New PRs also require
  `--title` and `--body-file`; an existing PR keeps its human title/body.
- `--expect-sha` optionally pins full HEAD. Default is capture HEAD during
  preflight and verify it again before moving the ref and before success.
- Without `--execute`, including explicit `--dry-run`, return exit 3 and a
  typed plan with no GitHub writes, journal, watch or trigger mutations.
  Combining the flags is usage error, exit 2. Failure/partial is exit 1;
  complete publication is exit 0. `--json` preserves the native error envelope.
- Read the caller worktree and body file, never silently the gateway cwd.
  Session publication follows in that session; a local operator outside a
  session must select an accessible chat session with `--reply-session`.
- Declare `@CommandAccess(kind:mutate, resource:pr, action:publish, risk:high,
  requiresConfirmation:true)` and concrete `@Returns`; no `@CliOnly`.
  Authorization runs before filesystem/network reads and before effects.
  `--execute` grants neither capability nor review approval. No auto-grants.

## Integrity and supported scope

- Require a clean named SHA-1 work branch, github.com origin matching repo,
  existing base, and head distinct from base/default. No implicit fetch,
  checkout, commit, merge, force update, fork destination or hook changes.
- Read immutable Git objects (`cat-file`, NUL-delimited `ls-tree`), not the
  working tree or space-split raw diffs. Recompute object hashes locally.
  Preserve binary bytes, modes, symlinks, parent order, message and identity
  timestamps including offsets. Create complete missing trees bottom-up.
- Only reuse GitHub objects whose returned IDs match. Verify every created
  blob/tree/commit ID and final tree AND commit SHA before changing refs.
  An equivalent tree with a different commit SHA is failure, never a substitute.
- Missing signed/noncanonical commits, non-UTF-8 paths/messages, new gitlinks,
  LFS pointer uploads, SHA-256 repos and new root history are refused in v1.
  Existing remote ancestry may contain these commits without reconstruction.
- Bounds: 100 missing commits, 5,000 objects, 50 MiB total, 8 MiB per blob,
  180 seconds overall and 20 seconds per subprocess. Exceeding them fails.
- Advance refs only with `force:false`; re-read before/after. GitHub has no
  expected-old-SHA parameter: this detects races but does not promise CAS.
  A same-SHA ref still requires PR/follow reconciliation and final verification.

## Failure and recovery

- Object upload is not transactional. A failed upload can leave unreachable
  objects; do not delete them or roll back someone else's ref. Rerun the same
  command, preferably with `--expect-sha`, observing actual remote state.
- Tree/SHA divergence stops before a ref mutation. Local head changes, remote
  branch movement and non-fast-forward updates fail explicitly.
- Reuse the unique open PR for this repo/head/base. Another base, multiple open
  matches or only closed/merged PRs is conflict. Never retarget or reopen.
- A lost ref/PR creation response is reconciled by reading the exact remote
  resource. A 422 alone is not success. Ref success followed by PR/follow
  failure returns partial phase, SHA, PR number when known and uncertainty.
- Reconcile through `ensureGhWatchFollow`, with a local active CI producer,
  using its local-only path without requiring or creating a Console watch,
  enabled correctly routed trigger and live runner confirmation of the loaded
  subscription fingerprint. Missing or old runtime fails preflight; a lost
  runner after mutation returns partial failure. `fireCount=0` is legitimate
  before the first event. Never start another runner to make a probe pass.
- New PRs are ready; legacy drafts become ready after follow verification.
  Final result includes repo/head/base, local and remote SHA/tree, PR URL,
  watch/CI-watch/trigger IDs, publishing session, verification time and current
  CI snapshot. Publication success does not assert that CI has passed.

## Audit and Review Gate

Persist an intent before each remote mutation and follow reconciliation, then
confirmation or uncertain failure, in `pr_publication_events` in the runtime
SQLite database. Use a dedicated synchronous FULL connection and a bounded
local repo/head lease. Audit failure prevents further effects. The logical
publication ID is repo/head/base/SHA; attempts have distinct IDs. Record actor,
executor, public context ID, session, phase, object IDs and final PR/follow IDs;
exclude credentials, context keys, file contents, PR body and raw subprocess
output. The journal is evidence, never the authority for remote state.

Ready only makes a PR eligible for review. Independent approval on the current
head, resolved review conversations and all required checks remain mandatory.
This command cannot approve, resolve discussions, merge or alter rulesets.
New PR descriptions disclose Git Data API transport and that this command did
not run git push/pre-push; the author supplies honest local/CI validation.
