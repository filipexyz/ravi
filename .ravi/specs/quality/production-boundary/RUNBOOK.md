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

Before deploying this version, review the release migrations, take the service's normal recoverable backup and arrange an explicit production launch configuration. The launcher must supply `RAVI_CONFIRM_PRODUCTION_STATE_DIR` equal to the absolute state root. An additional non-default production root must also be declared through `RAVI_PRODUCTION_STATE_DIR`. Keep confirmation scoped to the production launcher, not its development/test child processes. No deployment configuration, daemon restart or database repair is performed by this PR.

There is no automatic daemon exception: argv or cwd is not sufficient authority to migrate production. Tests refuse production even if confirmation is inherited. Existing databases need no schema/marker migration to gain protection.

## Publication

1. Commit on a work branch created from current `origin/dev`. Pre-commit still runs.
2. Preview and validate the exact committed tree:

```bash
bun scripts/publish-branch.ts --branch fix/example --test src/router/production-boundary.test.ts
```

3. Publish that tree using the same command plus `--execute`.
4. Open the PR with `gh pr create --base dev --head fix/example --body-file <description-file>`, filling every repository template section.
5. Read the CI result before claiming validation or requesting merge. Never merge without the operator's instruction.

The tool uses the authenticated `gh` CLI; it never prints credentials or changes hooks. It creates a new remote branch with one commit based on `origin/dev`. Fetch before preparing the branch. If the remote name already exists, choose a new work branch; this tool does not replace a ref or reconstruct local commit history. Publication errors may leave unreachable Git objects, never an unchecked ref after a hash mismatch.
