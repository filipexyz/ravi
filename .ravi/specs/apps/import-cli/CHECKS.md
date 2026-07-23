# Import CLI To Ravi App / CHECKS

## Checks

### Spec Exists

```bash
ravi specs get apps/import-cli --mode rules --json
```

Expected:

- Command MUST return inherited `apps` rules plus `apps/import-cli`.
- Output MUST include self-description preference.
- Output MUST include dry-run safety.
- Output MUST include review-required behavior.

### Dry-Run Safety

```bash
ravi apps import-cli "demo-cli" --id demo-app --dry-run --json
```

Expected:

- Dry-run MUST write no files.
- Dry-run MUST execute no domain commands.
- JSON output MUST report source, confidence, warnings, review-required fields,
  and planned files.

### Self-Description Preference

For a CLI that implements:

```bash
demo-cli manifest --json
```

Expected:

- Importer MUST use that metadata before help parsing.
- Generated command candidates SHOULD carry higher confidence.
- Args/options and JSON support MUST be taken from structured metadata.

### Help Fallback Guard

For a CLI that only exposes `--help`:

Expected:

- Import SHOULD still preview candidates when practical.
- Output MUST mark help-derived fields as low confidence.
- Permissions, mutation risk, schemas, storage, events, and UI MUST require
  review.

### JSON Contract Guard

For every imported operation consumed by agents/UI:

Expected:

- Command MUST support `--json`, or importer MUST emit a warning.
- Commands without JSON MUST NOT be presented as ready machine operations.

### Mutation Review Guard

For commands whose name or metadata indicates write/delete/send/publish/cancel
behavior:

Expected:

- Generated operation MUST be marked review-required.
- Permission suggestion SHOULD be present when possible.
- Operation MUST NOT be silently treated as safe read-only.
