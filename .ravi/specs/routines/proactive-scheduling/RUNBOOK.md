---
id: routines/proactive-scheduling
title: "Proactive Scheduling Runbook"
kind: capability
domain: routines
capability: proactive-scheduling
status: draft
---

# Proactive Scheduling Runbook

## Evaluate Whether to Create a Cron

1. Identify the next step from the current task.
2. Walk the decision checklist:
   - Is there a concrete action? (not vague)
   - Is it time-based or recurring? (not inactivity-based)
   - Can you express a concrete schedule? (ISO time, interval, or cron expression)
   - Do you have permission and context? (agent, account, session are clear)
   - Is expected noise low? (one-shot uses `--delete-after`)
   - Is there real operational risk if forgotten?
3. If all six are true, create the cron. Otherwise, skip or route to the correct primitive.

## Create a One-Shot Reminder

```bash
ravi cron add "Deploy check" \
  --at "2025-03-15T10:00" \
  --message "Verify deploy succeeded and check /health endpoint" \
  --delete-after
```

Then verify:

```bash
ravi cron show <id>
```

## Create a Recurring Check

```bash
ravi cron add "Daily metrics" \
  --cron "0 9 * * 1-5" \
  --message "Generate weekday metrics summary" \
  --tz "America/Sao_Paulo"
```

## Route to the Correct Primitive

- **Inactivity follow-up** (no reply in 2 hours): use `ravi sessions followups add`.
- **Deterministic shell work** (run a build, sync a file): use `ravi cron add --shell`.
- **Recurring behavior with policy**: create or reference a routine/spec, then use a short cron prompt that references it.
- **Event-driven**: use `ravi triggers add`.

## Inspect and Clean Up

```bash
ravi cron list --json
ravi cron show <id> --json
ravi cron rm <id>
```

## Avoid

- Do not create cron for every task.
- Do not create vague reminders without concrete actions.
- Do not duplicate existing cron jobs.
- Do not use cron for inactivity-based follow-up.
- Do not embed long policy in a cron prompt.
