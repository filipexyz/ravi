---
id: quality/state-boundary
title: "Real State and Process Roles"
kind: capability
domain: quality
capability: state-boundary
status: active
normative: true
---

# Why process roles

## Confirmed incident, 2026-10-31

The P0 investigation reproduced the exact chain: the generic-decisions harness supplied isolated `RAVI_STATE_DIR`; fixture cleanup deleted it; dispatcher recovery called `getSessionByName` -> `getDb`; path resolution fell back to `~/.ravi/ravi.db`; lazy initialization ran `migrateDecisions` and retired a table still required by the live daemon. A constructor proxy blocked 13 real-state opens. This supersedes the initial suspected release/session explanation.

The fixture restoration fix also landed through PR #768 and is retained when integrating current dev. The guard independently handles a future deletion of the variable. Live table recovery belongs to the P0 thread, not this PR.

## Selected boundary

An environment opt-in was rejected: it confuses environment with caller role, propagates into build/test children, and creates an outage risk at rollout. Automatic per-worktree directories were also rejected because they hide a missing target. Source/build/worktree calls must fail closed; only the installed runtime process can own real-state initialization.

Installed code is established from the module's package root, not cwd. The caller's actual PID and entrypoint are checked against the live PM2 registry; its parent must already be PM2 before the bounded registry query, so identity inspection cannot bootstrap a process manager. Inherited process labels and daemon-looking argv are insufficient. No new launch configuration is introduced.

## Single schema owner

Allowing daemon and channels to migrate the same SQLite introduces a race disguised as authorization. Channels needs normal data writes, not schema ownership. A ready marker per component and exact release makes startup order observable: the daemon prepares state; channels refuses incompatible or unfinished state before serving. The schema split is explicit in each store, and an integration test compares the entire SQLite schema before and after a channels startup/open.

## Publication choice

Git Data API publication avoids changing shared hooks on the live host. The remote snapshot's tree must equal local HEAD, and the local commit id is recorded for provenance. Remote commit ids differ; local signatures/history are not retained. Explicit updates append only to a fetched/integrated parent, recheck it and use `force: false`.

The alternative was a lightweight pre-push mode. This PR leaves the shared hook untouched and makes the separate publisher a documented, tested path. Full validation remains in PR CI.

[GitHub trees](https://docs.github.com/en/rest/git/trees#create-a-tree), [commits](https://docs.github.com/en/rest/git/commits#create-a-commit) and [refs](https://docs.github.com/en/rest/git/refs#create-a-reference) define the underlying object operations.

## Confirmed bypass evidence

The initial publications of [#766](https://github.com/filipexyz/ravi/pull/766) and [#767](https://github.com/filipexyz/ravi/pull/767) used `git -c core.hooksPath=/dev/null push`. That is a bypass even though persistent hooksPath remained `.githooks`, hook blobs were unchanged, and local/remote commit/tree hashes matched. Content integrity does not establish an authorized publication mechanism. Later checks must not rewrite that history.
