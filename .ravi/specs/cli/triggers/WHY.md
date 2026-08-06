# Triggers agent-first CLI contract / WHY

A trigger is a standing subscription: delete the wrong one and an automation
someone depends on silently stops reacting — there is no undo, the topic,
filter, cooldown and message template are gone. That makes `rm` the one braked
op in this domain.

`triggers test` deliberately stays unbraked. It fires the trigger with FAKE
event data (`_test: true`), mutates nothing (`changedCount: 0`), and exists
precisely so an agent can preview what a trigger would do BEFORE real events
hit it. Braking the preview tool would invert the safety model: agents would
lose the cheap dry-run they already have and be pushed toward validating
triggers with real traffic. The brake protects against irreversible effects;
`test` is the reversible rehearsal.

`add`, `set`, `enable` and `disable` also stay immediate: each has an inverse,
and the CLI already rejects invalid filters/topics before persisting, so the
risky part of configuration fails early rather than irreversibly.

Scope note that shaped this wave: `src/triggers/` is the trigger RUNTIME
(subscriptions, cooldowns, anti-loop) and was intentionally untouched — the
agent-first contract lives at the CLI boundary (`src/cli/commands/triggers.ts`)
only, so event-driven firings never pass through the brake.
