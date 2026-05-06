---
id: routines
title: "Routines Runbook"
kind: domain
domain: routines
status: draft
---

# Routines Runbook

## Convert A Cron Into A Routine

1. Identify the current cron:

```bash
ravi cron show <job-id> --json
```

2. Extract:
   - trigger schedule
   - owner agent
   - session
   - context reads
   - output contract
   - silence policy
   - mutation boundaries
   - failure modes

3. Create or update the routine spec/artifact.

4. Shorten the cron prompt so it references the routine contract instead of embedding the whole behavior.

5. Add quality checks for blindness, duplicate output, and contract violation.

## Investigate A Blind Routine

1. Check execution status.
2. Check whether the intended human/system outcome happened.
3. Compare output against the routine contract.
4. If status is ok but outcome failed, create a quality issue for blind success.

## Avoid

- Do not judge routines only by cron `lastStatus`.
- Do not let routine state live only in session context.
- Do not add recurring external actions without approval policy.
