# Observer Rules / CHECKS

## Checks

- Create two rules with the same id. Validation MUST fail.
- Create an agent rule and start a matching session. It MUST create the expected observer binding once.
- Replay matching for the same session. It MUST not create duplicate bindings.
- Create a tag rule for `task:auto-report`. A task with that tag MUST get the task reporter observer.
- Attach `task:auto-report` to a project only. It MUST NOT affect task sessions unless inheritance is explicitly enabled.
- Disable a matching rule. New sessions MUST not receive the observer; existing bindings MUST remain unless reconciliation is requested.
- Configure `observe` mode with `tasks.done` permission. Validation MUST fail.
- Configure two rules for the same observer role with conflicting delivery policies. Validation or explain MUST surface the conflict.
- Run explain on a session with matched and unmatched rules. Output MUST identify the tag or selector that caused each decision.
- Sort rules with identical priority by stable id. Matching output MUST be deterministic.
