---
id: quality
title: "Runtime Quality Runbook"
kind: domain
domain: quality
status: draft
---

# Runtime Quality Runbook

## Investigate A Suspected Production Agent Failure

1. Identify the scope:
   - session name/key
   - agent id
   - task id, if any
   - project id, if any
   - time window

2. Collect canonical evidence:

```bash
ravi sessions trace <session> --since <window> --explain --json
ravi events replay --session <session> --since <window> --json
ravi tasks list --text <session-or-agent> --json
ravi daemon logs --tail 200 --json
```

3. Classify the boundary:
   - runtime host
   - provider adapter
   - tool implementation
   - channel/Omni
   - prompt/skill
   - task/project orchestration

4. Create or update the root-cause packet:
   - observed behavior
   - expected behavior
   - exact timeline
   - minimal trace excerpts
   - suspected files/components
   - reproduction or validation command
   - default owner

5. Decide the action:
   - create task for fix/investigation
   - create insight for durable learning
   - link to project
   - open watch window
   - record silently

## After A Fix

1. Confirm validation commands passed.
2. Confirm daemon/runtime deployment state if the fix needs restart.
3. Open a watch window with success criteria.
4. Do not mark the failure mode closed until the watch window passes.

## Avoid

- Do not create one task per duplicate occurrence.
- Do not notify the user with raw logs when a root-cause packet is more useful.
- Do not call a failure fixed until the deployed runtime has observed the affected path.
- Do not hide low-confidence assumptions inside confident task titles.
