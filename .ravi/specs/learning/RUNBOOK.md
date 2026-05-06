---
id: learning
title: "Learning Loop Runbook"
kind: domain
domain: learning
status: draft
---

# Learning Loop Runbook

## Review A Completed Task Or Incident

1. Read the source work:

```bash
ravi tasks show <task-id> --json
ravi sessions trace <session> --since <window> --json
ravi artifacts list --task <task-id> --json
ravi insights list --task <task-id> --json
```

2. Classify the learning:
   - rule
   - debugging procedure
   - reusable skill
   - repeated routine
   - memory about Luis/person/project
   - eval/check
   - no durable learning

3. Choose destination:
   - rule -> spec
   - procedure -> skill or runbook
   - observation -> insight
   - personal/project context -> memory/project update
   - recurrence -> routine
   - regression -> check/eval

4. Write the smallest durable artifact that prevents re-learning the same thing.

5. Link provenance when the CLI supports it.

## Promote A Debugging Procedure Into A Skill

1. Name the specific trigger.
2. Write the shortest reliable workflow.
3. Include validation commands.
4. Include non-goals and safety boundaries.
5. Test the skill on a known case.
6. Record an insight or spec link explaining why it exists.

## Avoid

- Do not create a skill for one-off context.
- Do not put mandatory operational rules only in MEMORY.md.
- Do not write broad specs that say everything and constrain nothing.
- Do not let a cron prompt become the only documentation of a routine.
