# Events / CHECKS

## Audit Stream Integrity

```bash
bun test src/events/audit-stream.test.ts
```

Expected:
- all tests pass
- `RAVI_EVENTS_SUBJECTS` has no overlapping patterns
- prompt workqueue subjects are excluded

## Trigger Topic Catalog

```bash
bun test src/triggers/topic-catalog.test.ts
```

Expected:
- all catalog entries have unique ids
- all entries have schemas and message templates
- channel transport aliases are not documented as trigger-ready

## Spec Sync

```bash
ravi specs sync --json
```

Expected:
- `events` domain appears in the spec index
- capabilities include `audit-stream`, `topic-registry`, `gap-analysis`
