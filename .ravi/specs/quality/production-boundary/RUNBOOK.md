---
id: quality/production-boundary
title: "Development and Production Boundary"
kind: capability
domain: quality
capability: production-boundary
status: active
normative: true
---

# Operating the boundary

## Development

Use an isolated state directory, with the existing dependency tree when working on a production host:

```bash
RAVI_STATE_DIR="$(mktemp -d)" bun test src/router/production-boundary.test.ts
```

Do not put `RAVI_CONFIRM_PRODUCTION_STATE_DIR` in a test wrapper, shared shell profile or repository `.env`. A refusal means the caller lost its target; fix the caller or select an isolated directory. Do not work around it by changing HOME or copying a live database to a test path.

## Deployment

**Mandatory order: configure both production launchers FIRST, install the guarded release SECOND. Never reverse this.** An unconfigured daemon cannot open its database; that is total outage.

1. While the previous working release is still installed, review release migrations and take the normal recoverable service backup.
2. In the existing PM2 ecosystem/launcher definition, set `env.RAVI_CONFIRM_PRODUCTION_STATE_DIR` to the exact absolute production state root in BOTH app entries: `ravi` (daemon) and `ravi-channels`. If the production root is not the default, also set `RAVI_PRODUCTION_STATE_DIR`. Do not put confirmation in a shared shell profile or repo `.env`.
3. Apply that definition to both existing processes with the normal PM2 restart/reload procedure and `--update-env`, still running the old working package; persist with `pm2 save`. Check only the relevant key, executable path and readiness for BOTH processes, never dump a secret-bearing environment. Missing confirmation in either process blocks the upgrade.
4. Confirm the launchers run the installed package, outside any source/build/worktree. A package root containing `src` or `.git` cannot opt in; cwd or argv pretending to be a daemon does not change that.
5. Only now install the guarded release and restart/reload both through the same verified production launchers. Check daemon/channels readiness and task API behavior.

The refusal message names the variable, both PM2 processes and the ecosystem `env` location. It tells an operator who installed in the wrong order to restore the previous release first. No deployment, environment change or restart is performed by this PR.

### Wrong-order rollback

If someone installed first, do not disable the guard, rewrite the database or run a worktree against production. Reinstall the exact last known-good published version using the deployment's existing package manager, restore its normal PM2 launchers and recover both services. The guard refused before opening/migrating SQLite, so that refusal needs no data rollback. Then configure and verify both launchers on the working version as above before attempting the guarded upgrade again. If another operation changed data, use its own migration/backup recovery procedure rather than assuming this guard rolled it back.

There is no implicit daemon exception. Tests and source/build/worktree processes refuse production even when confirmation is inherited. Existing databases need no schema/marker migration to gain protection.

## Publication

1. Commit on a work branch created from current `origin/dev`. Pre-commit still runs.
2. Preview and validate the exact committed tree:

```bash
bun scripts/publish-branch.ts --branch fix/example --test src/router/production-boundary.test.ts
```

3. Publish that tree using the same command plus `--execute`.
4. Open the PR with `gh pr create --base dev --head fix/example --body-file <description-file>`, filling every repository template section.
5. Read the CI result before claiming validation or requesting merge. Never merge without the operator's instruction.

The tool uses the authenticated `gh` CLI; it never prints credentials or changes hooks. It creates a new remote branch with one commit based on `origin/dev`. Fetch before preparing the branch. For a follow-up on the same PR, fetch the work branch and merge its remote snapshot into the local work branch with `git merge --no-edit origin/<work-branch>` before making the next publication. Add `--update` to both preview and execute. The tool requires that remote parent in local history, rechecks its head and appends using `force: false`; it never rewrites history. A moved head requires fetching and integrating again. Publication errors may leave unreachable Git objects, never an unchecked ref after a hash mismatch.
