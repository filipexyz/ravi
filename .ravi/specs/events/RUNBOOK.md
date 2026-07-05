# Events / RUNBOOK

## Debug Flow

When an expected event is missing or not captured:

1. Check whether the subject is in the audit stream.

```bash
rg 'RAVI_EVENTS_SUBJECTS' src/events/audit-stream.ts
```

2. Check whether a publisher exists.

```bash
rg 'nats\.emit\(' src/ --no-filename -g '!*.test.*' | grep 'ravi\.subject\.name'
```

3. Check whether the event is in the trigger topic catalog.

```bash
ravi triggers topics
```

4. If the event is emitted but not captured in the audit stream, add the subject pattern to `RAVI_EVENTS_SUBJECTS` and run `bun test src/events/audit-stream.test.ts`.

5. If the event should be trigger-ready, add a catalog entry in `src/triggers/topic-catalog.ts` with a safe schema and message template.

## Adding a New Event Subject

1. Implement the publisher (`nats.emit(...)` or `publish(...)`) in the relevant source file.
2. Add the subject pattern to `RAVI_EVENTS_SUBJECTS` if it should be captured for replay/audit.
3. If `public-trigger`, add a `TriggerTopicCatalogEntry` in `src/triggers/topic-catalog.ts`.
4. Validate: `bun test src/events/audit-stream.test.ts`.
5. Document the event in the events skill (`src/plugins/internal/ravi-system/skills/events/SKILL.md`).
