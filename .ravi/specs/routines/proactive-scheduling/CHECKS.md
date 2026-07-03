---
id: routines/proactive-scheduling
title: "Proactive Scheduling Checks"
kind: capability
domain: routines
capability: proactive-scheduling
status: draft
---

# Proactive Scheduling Checks

## Spec Checks

```bash
ravi specs get routines/proactive-scheduling --mode full --json
ravi specs get routines/proactive-scheduling --mode checks --json
ravi specs sync --json
```

## Prompt Regression

```bash
bun test src/prompt-builder.test.ts
```

Verify:
- Active agents receive the Background Followup Automation section.
- Sentinel agents do not receive the section.
- The prompt contains the six-item decision checklist.
- The prompt distinguishes cron, session followups, shell cron, and routines/specs.
- The prompt includes `ravi cron show <id>` verification instruction.

## Decision Checklist Verification

A proactive cron is valid only when all six items are true:

1. Concrete next step exists.
2. Time-based or recurring (not inactivity).
3. Concrete schedule expressible as ISO time, interval, or cron expression.
4. Sufficient permission and context.
5. Low expected noise.
6. Real operational risk if forgotten.

## Negative Cases

A proactive cron MUST NOT be created when:

- The reminder is vague ("check on this later").
- The follow-up is inactivity-based (route to `ravi sessions followups`).
- A duplicate cron already exists for the same check.
- The cron would fire frequently without clear value.
- The recurring behavior has policy that should live in a routine/spec.

## Sentinel Exclusion

Sentinel agents (`mode=sentinel`) MUST NOT receive the Background Followup Automation prompt section. Verify with:

```bash
bun test src/prompt-builder.test.ts
```
