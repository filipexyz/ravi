# Events / Gap Analysis / WHY

## Rationale

Ravi's event bus (NATS) is the primary observability and automation surface. The trigger topic catalog, the `RAVI_EVENTS` replay stream, and `ravi events stream` all depend on publishers emitting canonical subjects with documented payloads.

Several lifecycle-heavy domains perform significant mutations without emitting any canonical event:

- **Triggers, cron, heartbeat** emit only generic `refresh` signals — no payload, no lifecycle distinction.
- **Session attach/mute/unmute/detach** mutations have no event at all, despite being referenced in the `sessions/attach` spec as requiring trace events.
- **Permission grants/revocations** are invisible — only denials are audited (`ravi.audit.denied`).
- **Route, instance, and agent config changes** emit only `ravi.config.changed` (empty payload), making operational debugging rely on log inspection.

This creates three concrete problems:

1. **Broken routine chaining** — routines cannot observe trigger/cron/heartbeat lifecycle because no trigger-ready subjects exist for those domains.
2. **Incomplete replay** — the `RAVI_EVENTS` stream captures what exists, but gaps in publishers mean replay and trace tools show incomplete operational history.
3. **Security blind spots** — permission grants have no audit trail. Instance registration changes that affect routing are silent.

## Decisions

- Conduct a systematic gap analysis comparing actual publishers, the audit stream, the trigger catalog, and related specs.
- Score each gap by value, risk, and effort to enable prioritized follow-up.
- Separate quick wins (safe payloads, low effort) from candidates requiring privacy/security review.
- Keep this analysis as research only — no new publishers, no runtime changes, no backfills.
- Treat `agent.created` and `session.created` as #165 scope, not duplicate recommendations.

## Rejected Alternatives

- Implementing all missing events in a single PR. This would be a large, unreviewed change across many domains with no human validation of payload safety.
- Adding events to the trigger catalog without classifying privacy risk. Sensitive events (permissions, routes, contacts) need human review before trigger exposure.
- Ignoring the gap and relying on CLI audit events (`ravi.*.cli.*.*`) as a proxy. CLI audit events are tool-level, not lifecycle-level — they capture "the CLI command ran" but not "the domain object changed state".
