# Triggers agent-first CLI contract / WHY

A trigger is a standing subscription: delete the wrong one and an automation
someone depends on silently stops reacting — there is no undo, the topic,
filter, cooldown and message template are gone. That makes `rm` the one braked
op in this domain.

`triggers test` uses synthetic event data (`_test: true`) and does not mutate
trigger configuration, but it is still triggered execution: the emitted event
can wake an agent or start a shell action. Its confirmation is therefore based
on the external execution effect, not on the command name or a database write.
Without `--execute`, the command exposes the target and execution type and
emits nothing.

`add`, `set`, `enable` and `disable` also stay immediate: each has an inverse,
and the CLI already rejects invalid filters/topics before persisting, so the
risky part of configuration fails early rather than irreversibly.

Scope note that shaped this wave: `src/triggers/` is the trigger RUNTIME
(subscriptions, cooldowns, anti-loop) and was intentionally untouched — the
agent-first contract lives at the CLI boundary (`src/cli/commands/triggers.ts`)
only, so event-driven firings never pass through the brake.
