# Import CLI To Ravi App / CHECKS

## Checks

### Spec Exists

```bash
ravi specs get apps/import-cli --mode rules --json
```

Expected:

- returns inherited `apps` rules plus `apps/import-cli`;
- includes self-description preference;
- includes dry-run safety;
- includes review-required behavior.

### Dry-Run Safety

```bash
ravi apps import-cli "demo-cli" --id demo-app --dry-run --json
```

Expected:

- writes no files;
- executes no domain commands;
- reports source, confidence, warnings, review-required fields, and planned
  files.

### Self-Description Preference

For a CLI that implements:

```bash
demo-cli manifest --json
```

Expected:

- importer uses that metadata before help parsing;
- generated command candidates carry higher confidence;
- args/options and JSON support are taken from structured metadata.

### Help Fallback Guard

For a CLI that only exposes `--help`:

Expected:

- import still previews candidates when practical;
- output marks fields as low confidence;
- permissions, mutation risk, schemas, storage, events, and UI require review.

### JSON Contract Guard

For every imported operation consumed by agents/UI:

Expected:

- command supports `--json`, or importer emits a warning;
- commands without JSON are not presented as ready machine operations.

### Mutation Review Guard

For commands whose name or metadata indicates write/delete/send/publish/cancel
behavior:

Expected:

- generated operation is marked review-required;
- permission suggestion is present when possible;
- operation is not silently treated as safe read-only.
