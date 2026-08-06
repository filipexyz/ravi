# Skill gates agent-first CLI contract / WHY

Skill gates are runtime governance: they decide which skill gets force-loaded
when a session touches a tool, group, or shell command. Deleting a custom gate
or disabling a default one (`rm`) and discarding an override (`reset`) change
that behavior for EVERY future session without any visible error — the skill
simply stops loading. Those are exactly the two ops that got the write brake.
`set`, `enable` and `disable` stay immediate: `set` is an upsert you can
re-issue, and `enable`/`disable` are exact inverses, so braking them would add
exit-3 friction to routine tuning without adding safety.

Two semantic decisions shaped this wave:

- `reset` only brakes when a configured override exists. Braking the
  no-override case would make the common "confirm we are at default" call exit
  3 for a write that discards nothing; the legacy no-op result (exit 0,
  `deleted:false`) is honest and keeps `reset` idempotent for automation.
- `rm` distinguishes default ids from custom ids in the plan
  (`disable-default` vs `delete-custom`), because the same command performs
  two different writes: default gates are never deleted, only disabled via an
  override row, while custom gates are physically removed. The plan makes the
  difference auditable before `--execute`.

`enable` keeps its distinct legacy message ("Skill gate override not found")
under the same `GATE_NOT_FOUND` code, with suggestions restricted to
configured overrides — enabling a default that was never overridden is a
no-op by construction, so suggesting default ids there would mislead.
