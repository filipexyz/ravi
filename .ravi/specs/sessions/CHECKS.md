# Sessions Checks

## Identity And Lifecycle Checks

- A session MUST always belong to exactly one agent.
- Renaming `session_name` MUST NOT rewrite `session_key`.
- Session reset MUST clear provider continuity state but MUST NOT drop attach
  subscriptions.
- Deleting a session MUST cascade to delete its subscriptions.
- Session visibility MUST be enforced: principals MUST only list, inspect, read,
  trace, or mutate sessions they own or hold `access`/`modify` grants for.

## Effective Model Checks

- `sessions list/info --json` MUST expose `effectiveProvider`, `effectiveModel`,
  `modelSource`, `modelPresetId`, and `modelPresetVersion`.
- A session `modelOverride` MUST win over the agent selection and be reported as
  `session_override`.
- Applying or updating a preset MUST NOT mutate session state.

## Commands

- `bun test src/router/sessions.test.ts src/router/sessions.rename.test.ts`
- `bun test src/cli/commands/sessions.test.ts`
