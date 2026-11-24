# Observer Rules / CHECKS

## Checks

- Create two rules with the same id. Validation MUST fail.
- Create an agent rule and start a matching session. It MUST create the expected observer binding once.
- Replay matching for the same session. It MUST not create duplicate bindings.
- Create a tag rule for `task:auto-report`. A task with that tag MUST get the task reporter observer.
- Attach `task:auto-report` to a project only. It MUST NOT affect task sessions unless inheritance is explicitly enabled.
- Disable a matching rule. New sessions MUST not receive the observer, and the bindings the rule already created MUST stop delivering at once (they stay stored, disabled, with their history).
- Delete a rule. Its bindings MUST be disabled.
- Enable the rule again and launch the source session. Its binding MUST deliver again.
- Configure `observe` mode with `tasks.done` permission. Validation MUST fail.
- Configure two rules for the same observer role with conflicting delivery policies. Validation or explain MUST surface the conflict.
- Run explain on a session with matched and unmatched rules. Output MUST identify the tag or selector that caused each decision.
- Sort rules with identical priority by stable id. Matching output MUST be deterministic.
- Enable a rule in text mode. The output MUST say bindings come back when each source session next launches and name `ravi observers refresh <session> --reconcile attach-missing`.
- Save a rule disabled while its binding cascade fails. The rule row MUST roll back with it (one transaction): no disabled rule with a live binding.
- A binding with `metadata.memory: "none"` MUST clear its observer session's provider state before delivering; the default MUST keep it; an unknown memory value MUST be rejected (`observation-plane.test.ts`, "Stateless observers").
- A `memory: "none"` delivery to an idle live observer runtime MUST retire it and start a new one; to a busy one it MUST wait for the turn to end, then do the same; a rolling delivery MUST keep the live conversation (`session-dispatcher.test.ts`, "stateless observer deliveries").
- A cold start for a `memory: "none"` delivery MUST NOT recover earlier deliveries from saved history; a rolling one MUST (`runtime-request-builder.crash-recovery.test.ts`).
- A `memory: "none"` delivery MUST NOT resume a stored conversation, even one a busy observer turn wrote back after the plane cleared it; a rolling delivery MUST resume it (`host-event-loop.reset-failure.test.ts`, "stateless observer delivery after a busy live turn").
- A `memory: "none"` delivery that arrives while an earlier one waits for the same observer MUST run after it (`session-dispatcher.test.ts`, "keeps delivery order").
