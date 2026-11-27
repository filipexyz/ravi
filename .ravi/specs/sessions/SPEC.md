---
id: sessions
title: Sessions
kind: domain
domain: sessions
capabilities:
  - attach
  - actions
  - visibility
  - provider-runtime
  - recap
tags:
  - sessions
  - runtime
  - chats
applies_to:
  - src/router/sessions.ts
  - src/router/router-db.ts
  - src/router/resolver.ts
  - src/omni/consumer.ts
  - src/runtime/host-event-loop.ts
  - src/runtime/runtime-request-builder.ts
  - src/cli/commands/sessions.ts
  - src/sessions/recap.ts
  - src/prompt-builder.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Sessions

## Intent

A Ravi session is the runtime container for one agent working on a stream of inputs. The `sessions` domain owns the canonical session model: how a session is created, how it persists across restarts, which chats feed into it, and which chat receives its outputs.

This domain is the semantic owner above:

- transport surfaces (channels, chats — see `channels/chats`);
- provider runtime state (resume/fork/replay — see `runtime/session-continuity`);
- visibility into live token/skill state (see `runtime/session-visibility`);
- portable subject context (see `threads`);
- a computed session recap (see `sessions/recap`).

Those capabilities all *reference* a session, but they MUST NOT redefine what a session is.

## Boundary

Sessions own:

- session identity (`session_key`, `session_name`, `agent_id`, `cwd`);
- session runtime preferences (`model_override`, `effort_override`, `thinking_level`) used as fallbacks after task/profile runtime selection and before agent/runtime defaults;
- which chats can dispatch input into the session (attach);
- which chat receives the session's external output (attach);
- last-source provenance for trace/correlation;
- session lifecycle: create, rename, reset, delete, ephemeral TTL;
- the session recap projection (computed on read; see `sessions/recap`).

Sessions do NOT own:

- channel transport behavior (delegated to Omni adapters);
- chat membership of humans (owned by `channels/chats` and `chat_participants`);
- provider session state (owned by `runtime/session-continuity`);
- thread/subject context (owned by `threads`);
- Knowledge threads or agent-cwd `MEMORY.md` (recap is a session projection, not semantic memory);
- identity resolution (owned by `contacts/identity-graph`).

## Definitions

- `session`: runtime container for one agent. Identified by a stable `session_key`. Has a canonical `session_name` for human reference.
- `session_chat_subscription`: record stating "chat X is wired to session S". One session MAY have many. One active subscription MAY be marked as the output attachment. This is the sole attach/output ledger.
- `session_chat_binding`: retired 1:1 compatibility table. Existing databases MAY still contain it until the one-time migrate/drop. Runtime MUST NOT read, write, or recreate it.
- `session_participant`: runtime participation projection (see `contacts/identity-graph`). It is not a permission and not an attach record.
- `session_key`: durable composite identifier (see `src/router/session-key.ts`). MUST remain stable for the session's lifetime.

## Invariants

- A session MUST always belong to exactly one agent.
- A session MUST have a stable `session_key`. Renaming the canonical `session_name` MUST NOT rewrite `session_key`.
- A session key under a trigger is reserved for the trigger runner: `agent:<agent>:trigger:<triggerId>`, `agent:<agent>:trigger:<triggerId>:own` and `agent:<agent>:trigger:<triggerId>:key:<24 hex>`. Creating a session with such a key from anywhere else MUST be refused (`SESSION_KEY_RESERVED`), and `ravi sessions send <name> -a <agent>` MUST say the name is reserved instead of creating it; an existing session is returned to whoever asks for it. The key is what tells a session a trigger created from one someone named after it, and the `:own` form is the one session a trigger's owner lends authority in (`routines/triggers`, `cli/bases` 6b). Keys derived from a trigger's (a thread opened from its session) are not reserved and are not a trigger's session.
- A session name spelled like a trigger's session key (any of the three forms above, in any letter case) MUST be only that session's own key, when the session is created, when its name is set and on rename: names and keys share one namespace, so no session goes by the key a trigger's session has or will have. Rename also refuses every other name starting with `agent:` that is not the session's own key, as before. A route that forces a reserved name on another session MUST NOT fail the inbound message: the session keeps the name it would have without it, and the route is logged.
- A session under a trigger's `:own` key MUST go by its key as its only name: the store names it so whatever the caller passes, and MUST refuse to give it another name. A character a name cannot hold (a dot, whitespace, `*`, `>`, from an unusual agent id) is written as `~<code>~`, and so is `~` itself, so the name is still one subject token, different keys keep different names, and the name is still spelled like a trigger's session key. A chat id MUST NOT resolve to such a session (`findSessionByChatId`). The name is therefore never free for another session, while the own session exists or after it is deleted, and what was stored under it (the journal, anything else keyed by name) is never inherited by another session.
- A session under a trigger's `:own` key runs that trigger's fires only: the dispatcher's intake MUST drop every other prompt published to it as a terminal intake failure (`trigger_own_session`), and `ravi sessions send` and the commands that publish like it MUST refuse it as a target (`cli/bases` 6b).
- A session MAY have one or more attached chats (see `sessions/attach`). Active attachments and the default output live only on `session_chat_subscriptions`.
- A physical provider turn MUST keep one immutable reply surface. Different chats and threads MUST be serialized into separate turns.
- An inbound turn MUST reply to its attached source chat or thread. The default output attachment is used only when a turn has no inbound source.
- An unattached inbound source or a source-less turn without a default output MUST NOT emit externally.
- A visible assistant utterance MUST persist as exactly one immutable chat.db row. Persist MUST NOT empty-join prior assistant history into a new row (`primeiro?Olá`). Multi-message turns MAY write several rows. Each completed utterance MUST INSERT before the `assistant.message` runtime SSE and MUST NOT wait for `turn.complete`. Replay of already-stored assistant text MUST NOT INSERT again.
- Operator / HTTP / app `sessions.send` (session-relay, no `--channel`/`--to`, no real inbound chat) is a session destination for emit. Leftover `lastChannel`/`lastTo` MUST NOT become `prompt.source` / `currentSource`. The default output attachment MUST NOT be the emit target. Chat emit stays fail-closed. Persist + `sessions.read` remain the sink.
- `ravi sessions send` and related inter-session commands inject prompt/context into a Ravi session. They MUST NOT be documented as direct external channel delivery primitives. Visible outbound channel delivery belongs to the session response path or to explicit channel/media/outbound commands.
- Operator CLI-only `sessions send` (no `--channel`/`--to`) sends the raw user text. `[System] Inform:` is reserved for agent-to-agent / in-context sends. `--raw` is the escape hatch.
- CLI-only `sessions send -w` waits for this turn's assistant transcript after `turn.complete`. Chat-attached `-w` still means delivered. Attach remains fail-closed for chat emit.
- Every accepted `sessions.send` (operator / HTTP / app) MUST end with a terminal runtime signal: `turn.complete`, `turn.failed`, or `turn.interrupted`. A mid-turn `assistant.message` MAY persist before that terminal. After a mid-turn utterance and a completed tool, provider silence MUST still emit `turn.failed` or `turn.interrupted` — the session MUST NOT remain with only the mid row and no terminal. Overlapping sends while a turn is in flight MUST queue behind the live handle (`after_response`, the sessions.send default) and MUST NOT start a second physical provider turn or Hub route preflight. Clients that poll recover from `sessions info --json` `turnUsage.lastTurn` (`status` + `completedAt`).
- Default `sessions read --json` is session + messages. The advertised skill catalog stays on `sessions visibility` or `sessions read --visibility`.
- Bare `ravi tui` MUST require a session name (usage error). It MUST NOT default to `main`.
- CLI-only session bootstrap MUST NOT inherit hardcoded `DEFAULT_RUNTIME_EFFORT = xhigh`. `sessions send --effort` sets an explicit override. The Ravi system prompt remains large.
- Session reset MUST clear provider continuity state (per `runtime/session-continuity`) but MUST NOT silently drop attach subscriptions — those are routing/wiring, not provider state.
- `ravi sessions set-effort <session> <level>` MUST persist an effort override using `none|minimal|low|medium|high|xhigh|max|ultra`; `clear` MUST remove only the session override.
- Session effort is separate from thinking. `ravi sessions set-thinking` MUST NOT accept effort values such as `max` or `ultra`, and `ravi sessions set-effort` MUST NOT mutate `thinking_level`.
- `ravi sessions list --json`, `ravi sessions info --json`, and runtime trace payloads SHOULD expose both effective runtime value and source where available.
- Deletion of a session MUST cascade to delete its subscriptions.
- Session visibility is authorization-bearing. Runtime principals MUST only
  list, inspect, read, recap, trace, or mutate sessions they own or have explicit
  grants for.
- `access session:<id>` authorizes session discovery/read/recap/trace beyond the
  current own session.
- `modify session:<id>` authorizes session mutation beyond the current own
  session.
- Slack parent/child lifecycle authority MAY authorize the narrow
  `sessions thread-configure` operation defined in `channels/slack/threads`.
  It MUST NOT become a generic `modify` or `access` grant; existing setters,
  reset/delete/rename, and transcript/recap/trace authorization remain unchanged.
- A chat attached to a session is not by itself permission to read or mutate
  that session.
- Hidden sessions SHOULD appear missing on direct lookup.
- `sessions ask` MUST record the Ask (`session_asks`, origin and asked session
  keys, 7-day window). While it is open, the asked session MAY run
  `sessions answer` to the asker without `access` to it, and MUST NOT gain
  anything else: read, recap, info, send, ask, execute, inform and every setter
  still need access. An answer sent through an Ask MUST NOT take `--channel`,
  `--to`, `--barrier`, `--steer` or `--immediate` (it waits for the asker's
  current response), MUST NOT carry the answerer's chat as the asker's
  approval source, and a caller that was not asked, or whose Ask closed, MUST get the
  same "Session not found" as an unknown session. The sender named in the Ask
  text grants nothing. Origin: 26/11, an agent asked by a session it could not
  see was refused the exact answer command the Ask told it to run.

- `sessions read` and `sessions recap` for a thread MUST return only that child's durable session history. An empty thread MUST remain empty; shared platform chat ids, message metadata and parent provider transcripts MUST NOT be used as silent fallback.

## Session Actions

`ravi sessions actions --json` is the canonical conversational action surface for a runtime session.

The detailed discovery, ownership and per-surface availability contract lives
in `sessions/actions`. Cross-channel action semantics live in
`channels/chat-actions`.

It MUST expose:

- the current session identity;
- active chat surfaces/subscriptions needed to confirm the target chat;
- recent own outbound message ids usable for own-message actions;
- `promptHint` and `usage.tools` with command-specific constraints;
- an `actions` list with stable action ids and status.

The action catalog MUST include existing executable conversational/channel commands instead of relying only on system-prompt prose. At minimum, when the underlying CLIs exist, it SHOULD advertise:

- `message.delete` via `ravi sessions delete-message`;
- `message.edit` via `ravi sessions edit-message`;
- `message.react` via `ravi react send`;
- `sticker.send` via `ravi stickers send`;
- `media.send` via `ravi media send`;
- `session.read` via `ravi sessions read --json`;
- `session.recap` via `ravi sessions recap --json`.

Actions that are conceptually useful but do not have an implemented command MUST be listed as `planned`, not documented as executable.

Agents MUST consult `ravi sessions actions --json` before using a conversational action whose availability or target is uncertain. The system prompt MAY name examples, but MUST NOT be the only source of truth for available action commands.

## Validation

- `bun test src/router/sessions.test.ts src/router/sessions.rename.test.ts src/router/commit-matched-route.test.ts`
- `bun test src/cli/commands/sessions.test.ts src/prompt-builder.test.ts`
- Scope tests SHOULD cover `sessions list/info/read/recap/trace` filtering through
  `access session:<id>` and mutation through `modify session:<id>`.
- `bun test src/sessions/recap.test.ts`

## Known Failure Modes

- Confusing `session_key` identity with `session_name` (display) — leads to broken routing when a session is renamed.
- Reintroducing `session_chat_bindings` as a second attach ledger — detach can appear to succeed and then resurrect on the next CLI bootstrap.
- Reintroducing `focus` as a separate primitive instead of using `attach` as the output attachment.
- Mutating the active turn source when a later chat message arrives — causes cross-channel routing leaks.
- Mentioning a conversational tool in the prompt without exposing it through `ravi sessions actions --json`.
- Marking a not-yet-implemented action as available instead of `planned`.
- Widening an empty chat scope to every message authored by the session's agent.
- Letting threads, observers, or knowledge collapse into the session concept.
- Treating agent-cwd `MEMORY.md` or Knowledge threads as a session recap.
- Session Boundary telling agents they can never recover context from another
  session — that blocks authorized `sessions recap <nameOrKey>`.

## Effective Model And Presets

Session JSON (`sessions list/info`) exposes the resolved `effectiveProvider`,
`providerSource` (`launch_override` | `observation_override` |
`session_override` | `last_used` | `restart_snapshot` | `agent_preset` |
`agent_default` | `global_default` | `runtime_default`), `effectiveModel`,
`modelSource` (`session_override` |
`agent_preset` | `agent_default` | `global_default` | `env_fallback` |
`runtime_default`), `modelPresetId`, `modelPresetVersion`, and `modelError`.
Display MUST match launch and MUST NOT invent a model when only a provider
override is set. A session `modelOverride` continues to win over the
agent-level selection and is reported as `session_override`, shadowing any
agent preset. Applying a preset MUST NOT mutate session state. See
`runtime/model-presets` and `runtime/defaults`.
