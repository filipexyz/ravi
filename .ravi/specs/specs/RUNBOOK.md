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

## Safe facade flow

For agent-created specs, create ancestors first and then plan the exact effect:

```bash
ravi specs facade plan new channels/presence/lifecycle \
  --title "Presence Lifecycle" --kind feature --full --json
```

Copy `planHash` and apply the same normalized intent:

```bash
ravi specs facade apply new <planHash> channels/presence/lifecycle \
  --title "Presence Lifecycle" --kind feature --full --json
```

Use `readback` to inspect files, ancestors, and index state; use `verify` for
the classified result. If apply returns an uncertain or divergent result, run
`recover` with the same arguments. Recovery never repeats the write.

For index work, use `facade plan sync` followed by `facade apply sync
<planHash>`. Legacy `ravi specs sync --json` remains valid for CI and existing
scripts and now reports `changed`.
