# Observer Rules / RUNBOOK

## Debug Flow

1. Identify the source session, task, agent, profile, project, and relevant tags.
2. Run rule explain for the source session.
3. Confirm which rules matched and which did not.
4. Inspect the tag bindings used by matched tag rules.
5. Check conflicts and priority order.
6. Confirm observer runtime provider/model overrides or inherited agent runtime settings.
7. Confirm generated observer bindings.
8. Inspect observer binding state in `runtime/observation-plane`.

## Expected Rule Explain Output

Rule explain SHOULD include:

- source metadata snapshot;
- evaluated rule ids in priority order;
- selector result for each rule;
- tags considered by target type;
- inheritance decisions;
- conflict decisions;
- observer bindings that would be created;
- observer bindings already present;
- validation warnings.
- effective observer runtime provider/model.

## Recovery

- If an observer appeared unexpectedly, start with rule explain. Do not inspect provider logs first.
- If a tag triggered the observer, inspect the tag target type and inheritance policy.
- If too many observers are created, disable the broadest matching rule first.
- If an observer lacks permission, update the observer rule grant or observer profile. Do not grant the source session tools.
- If a rule edit should affect existing sessions, run explicit reconciliation. Do not rely on implicit cleanup.
- If an observer runs on the wrong runtime/model, inspect the rule first, then the observer agent config, then global defaults.
