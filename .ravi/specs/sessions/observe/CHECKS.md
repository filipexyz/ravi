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
- `observers rules set --metadata '{"deliverTo":…}'` from a scoped caller MUST fail with SESSION_NOT_FOUND for a receiver the caller cannot reach, and no rule may be created (`src/cli/commands/observers-authorization.test.ts`).
- A trigger's own session holding owner reads MUST be refused as source by `observe` and by a direct rule write with `deliverTo`; a source marked after the rule exists MUST be skipped at delivery (`source_holds_owner_reads`) with nothing published.
- An `_observationNotice` prompt MUST be an isolated envelope (`hasIsolatedRuntimeTurnEnvelope`, `src/runtime/delivery-queue.test.ts`).
- A rule written by `rules set` or re-enabled by `rules enable` MUST skip delivery once its source holds owner reads; removing the delivery guard MUST fail both cases (`observation-plane.test.ts`, N5).
