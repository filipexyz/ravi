# Events / CHECKS

## Audit Stream Integrity

```bash
bun test src/events/audit-stream.test.ts
```

Expected:
- All tests MUST pass
- `RAVI_EVENTS_SUBJECTS` MUST NOT contain overlapping patterns within the same stream
- Prompt workqueue subjects (`ravi.session.*.prompt`) MUST be excluded from the audit stream

## Trigger Topic Catalog

```bash
bun test src/triggers/topic-catalog.test.ts
```

Expected:
- All catalog entries MUST have unique ids
- All entries MUST have schemas and message templates
- Channel transport aliases MUST NOT be documented as trigger-ready subjects unless a Ravi publisher actually emits them

## Spec Sync

```bash
ravi specs sync --json
```

Expected:
- The `events` domain MUST appear in the spec index
- Capabilities MUST include `audit-stream`, `topic-registry`, `gap-analysis`
- The command MUST exit without errors
