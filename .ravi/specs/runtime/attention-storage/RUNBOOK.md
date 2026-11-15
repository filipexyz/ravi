# Runbook

## Validate

Use a disposable directory and the guarded focused test command in CHECKS.md. The storage caller explicitly supplies a database and calls `migrateAttentionOccurrences` before use. The tests create their own temporary files and close all handles before cleanup. The initial schema is not an upgrader for the unshipped two-variant development fixture; use fresh temporary databases. No historical schema has been activated.

No command in this PR enables an orchestration mode or migrates the live database. Do not restart services to validate it. Publish using the authenticated installed `ravi pr publish` command after the focused checks; CI performs the full suite.

## Integrity failure

A divergent key or SQLite constraint failure is an error, not a reason to replace rows or fabricate a requirement. Preserve the database and inspect the caller's canonical identity. Only requirement, task_result and thread_decision are accepted. A thread decision is not repaired by fabricating a task. Preserve the existing ThreadRecord.id; item 1 owns any future ID-normalization migration.

## Rollback

Revert the module/spec change. No runtime imports or automatic migration registration exist, so reverting this PR has no live-state rollback step. Do not drop or rewrite production tables as part of this change.
