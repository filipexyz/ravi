# Runbook

## Validate

Use a disposable directory and the guarded focused test command in CHECKS.md. The storage caller explicitly supplies a database and calls `migrateAttentionOccurrences` before use. The tests create their own temporary files and close all handles before cleanup.

No command in this PR enables an orchestration mode or migrates the live database. Do not restart services to validate it. Publish using the authenticated installed `ravi pr publish` command after the focused checks; CI performs the full suite.

## Integrity failure

A divergent key or SQLite constraint failure is an error, not a reason to replace rows or fabricate a requirement. Preserve the database and inspect the caller's canonical identity. Unknown occurrence kinds remain rejected until a separately reviewed schema change adds them.

## Rollback

Revert the module/spec change. No runtime imports or automatic migration registration exist, so reverting this PR has no live-state rollback step. Do not drop or rewrite production tables as part of this change.
