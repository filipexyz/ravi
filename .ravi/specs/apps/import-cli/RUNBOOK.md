# Import CLI To Ravi App / RUNBOOK

## Import A CLI Draft

1. Prefer a CLI that self-describes:

```bash
<cli> manifest --json
```

2. Preview the Ravi import:

```bash
ravi apps import-cli "<cli>" --id <app-id> --dry-run --json
```

3. Inspect:

- source and confidence;
- operation candidates;
- commands missing `--json`;
- mutating/destructive commands marked for review;
- suggested permissions;
- suggested storage/events/UI placeholders;
- planned files.

4. Write only after review:

```bash
ravi apps import-cli "<cli>" --id <app-id> --name "Name" --description "Description" --json
```

5. Validate:

```bash
ravi apps check <app-id> --json
ravi apps show <app-id> --json
```

6. Curate the app:

- collapse low-level commands into daily operations;
- remove debug-only commands from top-level operations;
- add or correct permissions;
- add events/storage/UI only where they have operational value;
- update the generated skill so agents use declared operations only.

## Review An Imported App

Ask:

- Which operations are real app buttons?
- Which commands stay CLI-only/debug-only?
- Which operations mutate external state?
- Which operations need confirmation, `--dry-run`, or stronger permission?
- Which outputs are machine-readable JSON?
- Which operation results should emit events?
- Which state belongs in app storage versus upstream systems?
- Which UI views would make the operation materially easier?

## Improve A CLI For Import

If import is weak, add a self-description command to the source CLI:

```bash
<cli> manifest --json
```

The payload should describe command groups, args, options, JSON support,
mutation risk, examples, schemas, and safe health checks. Re-run import after
the CLI publishes that metadata.
