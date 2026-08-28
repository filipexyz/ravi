# Sessions Checks

## Identity And Lifecycle Checks

- A session MUST always belong to exactly one agent.
- Renaming `session_name` MUST NOT rewrite `session_key`.
- Session reset MUST clear provider continuity state but MUST NOT drop attach
  subscriptions.
- Deleting a session MUST cascade to delete its subscriptions.
- Session visibility MUST be enforced: principals MUST only list, inspect, read,
  recap, trace, or mutate sessions they own or hold `access`/`modify` grants for.

## Effective Model Checks

- `sessions list/info --json` MUST expose `effectiveProvider`, `effectiveModel`,
  `modelSource`, `modelPresetId`, and `modelPresetVersion`.
- A session `modelOverride` MUST win over the agent selection and be reported as
  `session_override`.
- Last-used `session.runtimeProvider` MUST be reported as `providerSource=last_used`
  when no session `set-provider` override is present.
- Applying or updating a preset MUST NOT mutate session state.

## Commands

- `bun test src/router/sessions.test.ts src/router/sessions.rename.test.ts`
- `bun test src/cli/commands/sessions.test.ts src/cli/session-cli-surface.test.ts`
- CLI-only `sessions send -w --json` MUST return this turn's transcript text
  when no `.response` event is emitted.
- Default `sessions read --json` MUST omit `runtimeSessionParams.skillVisibility`.
- Operator `sessions send` without a caller session MUST NOT wrap `[System] Inform:`.
- Operator / HTTP / app `sessions.send` without `--channel`/`--to` MUST NOT
  emit to leftover `lastChannel` or the default output attachment. Persist
  MUST still store the assistant row for `sessions.read`.
- Bare `ravi tui` MUST fail with a usage error instead of opening `main`.
