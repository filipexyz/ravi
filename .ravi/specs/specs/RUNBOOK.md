# Ravi Specs / RUNBOOK

## Debug Flow

Use this flow when a spec is missing, stale, or not being applied by an agent.

1. List specs:

```bash
bun src/cli/index.ts specs list --json
```

2. Read the effective context:

```bash
bun src/cli/index.ts specs get <spec-id> --mode full --json
```

3. Rebuild the index from Markdown:

```bash
bun src/cli/index.ts specs sync --json
```

4. If a project should carry the spec as context, link it:

```bash
bun src/cli/index.ts projects link <project-id> spec <spec-id>
```

5. If a spec does not appear after sync, inspect:

```bash
find .ravi/specs -name SPEC.md -print
```

Check for id/path mismatch, invalid kind for depth, missing frontmatter, or invalid status.
