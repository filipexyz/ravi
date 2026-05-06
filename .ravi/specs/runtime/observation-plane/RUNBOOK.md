# Observation Plane / RUNBOOK

## Debug Flow

1. Identify the source session key and source turn id.
2. List observer bindings for the source session.
3. Confirm each binding's observer agent, observer session, runtime provider/model overrides, event filters, delivery policy, mode, and enabled state.
4. Replay source runtime events for the affected turn.
5. Confirm which events matched each binding.
6. Inspect observation deliveries and dedupe keys.
7. Inspect observer session traces separately from the source session trace.
8. Confirm the observer session ran with the expected runtime provider/model before inspecting provider logs.
9. Check observer context-key permissions before investigating tool failures.

## Expected CLI Surface

The implementation SHOULD eventually expose:

```bash
ravi observers list [--session <session>] [--agent <agent>] [--task <task>]
ravi observers show <binding-id>
ravi observers events <binding-id> [--since 1h]
ravi observers replay <binding-id> --turn <turn-id> --dry-run
```

Operator output MUST distinguish:

- binding matched or not matched;
- events selected;
- events dropped by filter, budget, or redaction;
- delivery queued;
- observer run started;
- observer run completed, failed, skipped, or deduped.

## Recovery

- If an observer is failing repeatedly, disable the observer binding or rule. Do not disable the source session.
- If observer delivery is duplicated, verify event id and delivery dedupe keys before patching task-report logic.
- If source turns are slow, confirm the source path is not waiting on observer execution.
- If an observer lacks a tool, fix the observer context/permission grant. Do not grant tools to the source session as a workaround.
- If payload redaction hides required data, update the observer binding payload policy explicitly and audit the new exposure.
