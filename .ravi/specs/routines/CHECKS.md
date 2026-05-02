---
id: routines
title: "Routines Checks"
kind: domain
domain: routines
status: draft
---

# Routines Checks

## Spec Checks

```bash
ravi specs get routines --mode full --json
ravi specs sync --json
```

## Routine Readiness

- Has owner.
- Has trigger.
- Has context sources.
- Has output contract.
- Has silence policy.
- Has mutation/approval boundary.
- Has at least one quality failure mode if it affects the user.

## Blindness Check

A routine is blind when:

- execution status is `ok`
- but the expected state change, user response, artifact, or decision did not happen
- and no quality issue/watch was opened
