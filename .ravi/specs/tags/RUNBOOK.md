# Tags / RUNBOOK

## Inspect Current Tags

```bash
ravi tags list --json
ravi tags search --tag <slug> --json
ravi tags search --agent <agent-id> --json
ravi tags search --session <session-name> --json
```

For large systems, prefer filtered searches. Avoid unfiltered machine output
unless debugging the registry itself.

Useful SQLite inspection:

```bash
sqlite3 ~/.ravi/ravi.db \
  "SELECT kind, count(*) FROM tag_definitions GROUP BY kind;"

sqlite3 ~/.ravi/ravi.db \
  "SELECT asset_type, count(*) FROM tag_bindings GROUP BY asset_type ORDER BY 2 DESC;"

sqlite3 ~/.ravi/ravi.db \
  "SELECT t.slug, b.asset_type, count(*) FROM tag_bindings b JOIN tag_definitions t ON t.id = b.tag_id GROUP BY t.slug, b.asset_type ORDER BY t.slug, b.asset_type;"
```

## Create a Tag

```bash
ravi tags create task.observed \
  --label "Observed Task" \
  --description "Tasks whose sessions should receive operational observation"
```

Use `--kind system` only for tags owned by Ravi/system policy.

## Attach a Tag

```bash
ravi tags attach task.observed --task task_123
ravi tags attach domain.ravi --project ravi-core
ravi tags attach observer.task-reporter --profile tasks
```

The target must be the stable canonical id for that asset type.

## Explain Policy Consumers

For Observation Plane:

```bash
ravi observers rules explain --session <session>
```

Expected:

- direct and inherited tags are visible;
- matched/unmatched tag rules show reasons;
- inherited tag matches are marked as inherited;
- observer bindings list the rule that created them.

## Migrating a Local Tag Field

1. Inventory the existing field and commands.
2. Decide whether the tags are internal Ravi tags, external provider tags, or
   document/frontmatter tags.
3. Define the canonical asset type.
4. Create definitions for existing slugs.
5. Backfill bindings with metadata:

```json
{
  "source": "migration",
  "from": "artifacts.tags_json",
  "migratedAt": "YYYY-MM-DD"
}
```

6. Update reads to use `tag_bindings`.
7. Update writes to write canonical bindings.
8. Keep old field as compatibility only if needed.

## Safety Checklist Before Tags Drive Policy

- The tag exists as a definition.
- The target binding exists and points at the intended asset id.
- The policy consumer has an explicit rule referencing the tag.
- Inheritance is disabled unless explicitly desired.
- Explain output names the matched tag and rule.
- The observer/automation/permission does not grant broader capability than the
  tagged asset requires.
