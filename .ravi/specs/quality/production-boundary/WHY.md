---
id: quality/production-boundary
title: "Development and Production Boundary"
kind: capability
domain: quality
capability: production-boundary
status: active
normative: true
---

# Why this boundary

## Confirmed incident, 2026-10-31

The P0 investigation reproduced this chain in the generic-decisions worktree:

1. The batch harness supplied an isolated `RAVI_STATE_DIR`.
2. `cleanupIsolatedRaviState()` deleted it instead of restoring the harness value.
3. Runtime recovery tests called `getSessionByName()` and then router `getDb()`.
4. `getRaviStateDir()` fell back to `~/.ravi`; the SQLite constructor opened production.
5. Branch-only `migrateDecisions()` ran during initialization and retired `task_decisions`, while the live release still required it. The task API returned 500.

A constructor proxy blocked 13 production opens; the first came from the runtime recovery case in `session-dispatcher.test.ts`. The exact process is established by that reproduction, not by the earlier suspected session/time window. Recovery of the live table belongs to the P0 workstream, not this change.

## Choice: explicit production confirmation at the database boundary

Automatic per-worktree state was rejected: it hides a missing target and relies on detecting all launch contexts (source, bundles, scripts, cwd changes). Only fixing fixture cleanup was rejected because future code can unset or override the environment again. Refusing before SQLite opens closes the class of defect independently of command naming and future migrations inside initialization.

The same guard covers all current writable state constructors, including contacts, credentials and Console scope, which can open `ravi.db` without router initialization. The path check runs again before cached reuse. Production opt-in is deliberately disruptive at rollout: both PM2 launchers must acknowledge the state root and migration implications BEFORE the guarded package is installed. Wrong ordering means total outage, not degradation. No daemon configuration is changed by this PR. Confirmation is additionally rejected in source/build/worktree code, so inheriting the production environment cannot authorize development code.

## Choice: official Git Data API publication

The alternative was a lightweight pre-push mode. The API tool avoids changing shared hook policy on the production machine. It publishes a squash snapshot whose tree must equal local HEAD; it records the local commit for provenance. Tradeoffs: the remote commit id differs, local signatures are not preserved, and each publication is a squash snapshot. Creation refuses existing branches. Explicit updates append a snapshot to the fetched remote parent only after that parent is integrated locally; stale remote heads refuse. It never force-pushes or merges a PR.

Build, typecheck, lint, generated-contract checks and full tests remain in the existing PR CI workflow. Local checks are focused, deterministic and state-isolated. A successful API publication does not imply that CI passed.

Git object semantics: [GitHub trees](https://docs.github.com/en/rest/git/trees#create-a-tree), [commits](https://docs.github.com/en/rest/git/commits#create-a-commit), and [refs](https://docs.github.com/en/rest/git/refs#create-a-reference).

## Confirmed publication bypasses

The initial publications of [PR #766](https://github.com/filipexyz/ravi/pull/766) and [PR #767](https://github.com/filipexyz/ravi/pull/767) used `git -c core.hooksPath=/dev/null push`. This disables hooks for that invocation even though persistent `core.hooksPath` stays `.githooks` and hook file hashes remain unchanged. It is a bypass, not an authorized exception and not Git Data API publication.

The reporting thread verified that each local commit/tree matched its PR head/tree, with no force-push or hook-file edits. That proves content integrity, not compliance with the publication path. The initial mechanism must remain recorded accurately; later successful tests or CI do not rewrite how the branch was published.
