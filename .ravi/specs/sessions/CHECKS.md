# Sessions Checks

## Identity And Lifecycle Checks

- A session MUST always belong to exactly one agent.
- Renaming `session_name` MUST NOT rewrite `session_key`.
- Session reset MUST clear provider continuity state but MUST NOT drop attach
  subscriptions.
- Attach/detach MUST persist only on `session_chat_subscriptions`. Detach MUST
  remain detached after repeated database initialization.
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
- A second `sessions.send` during an in-flight turn MUST queue and both
  accepted sends MUST get a terminal `turn.complete` / `turn.failed` /
  `turn.interrupted` plus a terminal `lastTurn`. The second send MUST NOT
  hang open without a terminal. `sessions send -w` MUST wait for that send's
  own terminal, not the overlapped turn's `turn.complete`.
- Persist MUST refuse empty-join mash (`primeiro?Olá`) and keep one clean row
  per visible assistant utterance. Multi-message turns (`Part one.` +
  `Part two.`, or `A1_LIVESTR_X` + `A2_LIVESTR_X` + `A3_LIVESTR_X`) MUST
  persist as separate rows as soon as each `assistant.message` arrives, before
  `turn.complete`. The `assistant.message` runtime SSE MUST fire after the
  INSERT so `sessions.read` can see the new row.
- A mid-turn assistant utterance followed by a tool and a second utterance
  MUST persist both rows and end with `turn.complete` plus a terminal
  `lastTurn`. A mid-turn utterance followed by a completed tool and then
  provider silence MUST NOT leave the session with only that mid row and no
  terminal for minutes — the host MUST emit `turn.failed` / `turn.interrupted`
  and write a terminal `lastTurn`.
- Bare `ravi tui` MUST fail with a usage error instead of opening `main`.
