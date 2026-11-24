# Session Observe Checks

- A healthy observed turn MUST send nothing; a turn that ends after tool work with two agent messages MUST send exactly one `[System] Inform: [from: ravi observer]` to the receiver, naming `turn.no_final_reply` and `chat.narration`, with no `_observation` field (`src/cli/commands/sessions-observe.test.ts`).
- `observe` MUST attach the binding at once; running it twice MUST keep one rule; `unobserve` MUST stop delivery; `--follow` MUST deliver every finished turn.
- A scoped caller MUST get "Session not found" for a session it cannot reach on either end, and no rule may be created.
- Self-observation, unknown conditions and `--follow` with `--when` MUST be refused.
- Condition rules and the end-of-turn-only gate MUST pass `src/runtime/observation-plane.test.ts` ("Observer conditions", "Condition-gated observer bindings"), including fail-closed on a persisted invalid `when`.
- A turn that dies on inactivity MUST reach a condition-gated observer exactly once, also when the provider reports the aborted turn late (`src/runtime/session-trace.test.ts`, "ends an inactivity-recovered turn for end-of-turn observers").
- Two sessions observing each other MUST NOT loop: the notice MUST carry `_observationNotice` and classify as an observer-originated turn.
- After renaming both ends, delivery MUST go to the receiver's new name, a session that took the old name MUST receive nothing, and `unobserve` by the new names MUST remove the rule.
- A trigger's own session MUST be refused as receiver; `--follow` with `--when` and an unknown condition MUST throw a `USAGE_ERROR` with exit code 2.
