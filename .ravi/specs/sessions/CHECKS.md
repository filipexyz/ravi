# Sessions Checks

## Identity And Lifecycle Checks

- A session MUST always belong to exactly one agent.
- Renaming `session_name` MUST NOT rewrite `session_key`.
- A session under a trigger's key (`agent:<agent>:trigger:<id>`, its `:own`
  form and its `:key:<24 hex>` form) MUST be created only by the trigger
  runner: every
  other creation throws `SESSION_KEY_RESERVED`, an existing one is returned
  to anybody, keys that only resemble or derive from a trigger's stay open
  (`src/router/sessions.test.ts`), and `sessions send <name> -a <agent>`
  refuses the name without creating a session
  (`src/cli/commands/sessions.test.ts`).
- A name spelled like a trigger's session key MUST be accepted only as the
  session's own key, at creation and by `updateSessionName`, in any letter
  case; any other name MUST be taken as before, one spelled like another
  kind of key included (`src/router/sessions.test.ts`).
- A trigger's own session MUST be named by its key whatever it is asked,
  with the characters a name cannot hold written out, and MUST refuse
  another name at creation, by `updateSessionName` and by
  `renameSessionName` (`src/router/sessions.test.ts`,
  `src/triggers/__tests__/runner-owner.test.ts`).
- `findSessionByChatId` MUST skip a trigger's own session and return the
  chat's other session, or none (`src/router/sessions.test.ts`).
- A prompt published to a trigger's own session MUST become a turn only when
  it is that trigger's fire or the runtime's restart notice for that session
  (`src/runtime/session-dispatcher.test.ts`), and `sessions send` MUST refuse
  the session as a target (`src/cli/commands/sessions.test.ts`).
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

- `bun test src/cli/commands/sessions.test.ts`: an empty child returns zero rows despite parent/sibling same-chat history and metadata; a populated child returns only its own rows.

- `bun test src/sessions/ask-grants.test.ts`: with an open Ask, the asked session's `sessions answer` to the asker passes the hook by key, by name (also a name shaped like a key) and after leading options (`--json`, `--barrier <value>`); `read`, `info`, `send`, `ask`, `execute`, `inform` and `reset` on the asker stay refused; a third session, an expired Ask, a withdrawn grant and a session deleted and recreated under the same key find no grant.
- `bun test src/cli/commands/sessions.test.ts -t "open Ask"`: the Ask is recorded, an undelivered Ask withdraws its grant, a trigger's own session gets none, the answer is delivered with a receipt that shows only the asker's key, `--channel`/`--to` are refused, and a caller never asked gets "Session not found".
