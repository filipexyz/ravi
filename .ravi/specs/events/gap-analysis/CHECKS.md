# Events / Gap Analysis / CHECKS

## Spec Integrity

```bash
ravi specs sync --json
```

Expected:
- `events/gap-analysis` appears in the spec index
- no orphaned or missing spec errors

```bash
ravi specs get events/gap-analysis --mode full --json
```

Expected:
- spec metadata includes `id: events/gap-analysis`, `kind: capability`, `domain: events`
- `related_specs` references `routines/triggers`, `sessions`, `sessions/attach`, `permissions`, `runtime`, `runtime/observation-plane`, `tasks`, `channels`, `contacts`, `artifacts`

```bash
ravi specs get events/gap-analysis --mode checks --json
```

Expected:
- returns this CHECKS.md content

## Parent Domain Spec

```bash
ravi specs get events --mode full --json
```

Expected:
- `events` domain spec exists with `id: events`, `kind: domain`
- capabilities include `gap-analysis`

## Audit Stream Test

```bash
bun test src/events/audit-stream.test.ts
```

Expected:
- all tests pass
- `RAVI_EVENTS_SUBJECTS` has no overlapping patterns
- prompt workqueue subjects are excluded

## Trigger Topic Catalog Test

```bash
bun test src/triggers/topic-catalog.test.ts
```

Expected:
- if test exists, all tests pass
- if test does not exist, document as a recommended follow-up

Note: `src/triggers/topic-catalog.test.ts` does not currently exist. This is a recommended follow-up to add basic catalog invariant tests (no duplicate ids, all entries have schemas, pattern format validation).

## Matrix Completeness

Manual verification:

- [ ] Matrix contains at least 12 evaluated candidates
- [ ] Matrix contains at least 5 recommended follow-up candidates
- [ ] Each candidate includes: subject, owner, classification, replay decision, trigger catalog decision, payload sketch, consumers, affected specs, value/risk/effort score, privacy risk
- [ ] Matrix covers seed areas: session attach/mute/unmute/detach/rename; route create/update/delete; permission grant/profile changes; trigger create/update/enable/disable/fire/fail; cron/heartbeat run lifecycle; instance register/update/delete; observer binding lifecycle
- [ ] `agent.created` and `session.created` are explicitly treated as #165 scope
- [ ] Privacy-sensitive candidates are marked as `replay-only` or `internal-control`
- [ ] No payload sketch contains secrets, credentials, raw prompts, context keys, or private paths

## Coverage Snapshot Validation

```bash
# Verify publisher inventory matches codebase
rg 'nats\.emit\(' src/ --no-filename -g '!*.test.*' -g '!*.fixture.*' | grep -oP '"ravi\.[^"]+' | sort -u
```

Expected:
- output matches the "Actual Publishers" table in SPEC.md
- any new subjects not in the table indicate the analysis needs updating
