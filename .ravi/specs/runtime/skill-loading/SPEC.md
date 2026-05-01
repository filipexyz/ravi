---
id: runtime/skill-loading
title: "Runtime Skill Loading"
kind: capability
domain: runtime
capability: skill-loading
tags:
  - runtime
  - skills
  - sessions
  - context
  - compact
applies_to:
  - src/runtime
  - src/skills/manager.ts
  - src/runtime/runtime-event-loop.ts
  - src/runtime/runtime-request-context.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Runtime Skill Loading

## Intent

`skill-loading` defines how the runtime tracks which skills are loaded into the current session at any moment. The capability gives the runtime, the CLI, and dependent tools a single source of truth for loaded-skill state so that visibility queries, gating decisions, and compaction handling all agree on the same vector.

The capability exists because today there is no canonical place that answers "is skill X loaded right now in this session?". Without that, gates over tool execution (see `runtime/context-keys/skill-gate`) cannot be enforced reliably.

## Model

- Each runtime session MUST own a skill visibility snapshot with:
  - `skills`: ordered per-skill records for everything Ravi can identify in the session window.
  - `loadedSkills`: compatibility projection of skill identifiers that are loaded into the live provider context.
- A skill record MUST include `id`, `provider`, `state`, `confidence`, `source`, `evidence`, `loadedAt`, and `lastSeenAt`.
- `state` MUST be one of:
  - `available`: discovered in a Ravi plugin, provider catalog, or local skill directory.
  - `synced`: materialized into provider-specific storage for this session or cwd.
  - `advertised`: included in a prompt, instruction catalog, or provider bootstrap payload.
  - `requested`: explicitly requested by the user, runtime, or provider approval flow.
  - `loaded`: provider context contains the skill body for the current session window.
  - `stale`: previously observed as loaded, then invalidated by compact, reset, provider cache invalidation, or file change.
  - `unknown`: the provider cannot report enough information to classify the skill.
- `confidence` MUST be one of:
  - `observed`: Ravi saw a provider event, control response, or Ravi-owned injection completion proving the state.
  - `inferred`: Ravi matched provider data strongly enough to infer the state, but did not observe a load event.
  - `declared`: Ravi declared the state through configuration, bootstrap, or prompt text.
  - `unknown`: Ravi lacks reliable evidence.
- `loadedSkills` MUST contain only records with `state=loaded` and `confidence=observed`. `available`, `synced`, `advertised`, and `requested` MUST NOT be projected into `loadedSkills`.
- The vector MUST start empty at session creation. A session MUST NOT inherit a non-empty `loadedSkills` from any previous session.
- A skill enters the vector when:
  - It is auto-discovered and invoked by the harness, and the adapter observes the provider's load/invocation signal, or
  - The runtime explicitly injects the skill (e.g. via the skill-gate auto-load flow, when implemented), or
  - A Ravi-owned skill read command (`ravi skills show <skill>` or repo `bin/ravi skills show <skill>`) completes successfully and returns the skill body.
- A skill exits the vector only via a vector reset (compact or new session). A loaded skill MUST NOT be silently evicted.
- The vector MUST be reset to empty on:
  - Session creation.
  - Compaction (auto or manual).
  - Explicit `session reset` invocations.

## Runtime Detection Matrix

| Provider | Available/synced signal | Loaded signal | Current visibility contract |
| --- | --- | --- | --- |
| Claude Code | Ravi plugins are discovered during runtime bootstrap and passed to the provider when plugin support is enabled. | Provider-native Skill tool or equivalent tool-use event, normalized by the adapter after the event shape is verified. | Passing a plugin to Claude is `advertised` or `available`, not `loaded`. Claude may report `loaded` only from observed provider events or Ravi-owned injection completion. |
| Codex | `syncCodexSkills` materializes Ravi plugin skills into the Codex skills directory; app-server `skills/list` reports skill metadata; `skills/changed` invalidates that metadata. | No stable dedicated loaded-skill notification is currently exposed. Thread start/resume `instructionSources` may prove instruction files loaded; it can be treated as `loaded` only if the path is matched to a canonical skill file. A successful `ravi skills show <skill>` tool call is Ravi-owned read evidence and may mark that skill `loaded`. `UserInput` items with `type=skill` are `requested` unless followed by load evidence. | Codex MUST report `synced`/`advertised` for Ravi-managed skills today. It MUST NOT mark a skill `loaded` just because it was synchronized or listed in the system prompt. |
| Pi | No Ravi plugin or skill catalog support in the current RPC MVP. | No skill-loaded event or state exists in the current Pi RPC surface. | Pi MUST report `unknown` or an empty `loadedSkills` vector until the RPC or SDK provider exposes explicit skill state/events. |

## Rules

- The vector MUST be persisted alongside the session record so crash recovery and dispatch reuse can reconstruct state without scraping provider events.
- Vector mutations (add, reset) MUST emit structured events on the runtime event stream so observability can replay the timeline.
- The skill identifier in the vector MUST be the canonical skill name (frontmatter `name`), not a path or alias. Discovery and gating use the same identifier surface.
- The vector MUST be readable from a child Ravi context so tools running under `RAVI_CONTEXT_KEY` can introspect it without elevated permissions.
- Every adapter (Claude Code, Codex, Pi) MUST report skill-loading consistently. If a provider exposes a different mechanism for "skill in context", the adapter MUST translate it into the same vector shape before exposing it.
- Compaction MUST NOT preserve `loadedSkills`. Even if the underlying provider keeps the textual content of a skill across compaction, the runtime MUST treat compaction as a fresh skill-loading window so gates re-evaluate correctly.
- Adapters MUST NOT conflate provider discovery, local sync, prompt catalog text, approval requests, or UI mentions with loaded state.
- Provider-specific evidence MUST be retained in the skill record so operator UI can explain why a skill is shown as loaded, stale, or unknown.
- Ravi-owned skill read evidence MUST be recorded as `evidence.kind=tool-call` with the canonical skill id resolved from `ravi skills show` output when available.
- If provider evidence is ambiguous, the adapter MUST prefer `unknown` or `requested` over `loaded`.
- `skills/changed`-style provider invalidation MUST mark affected `available`, `synced`, and `advertised` metadata stale until refreshed; it MUST NOT mutate `loadedSkills` unless the loaded skill's canonical source path changed.

## Interaction with Other Capabilities

- `runtime/session-visibility` reads `loadedSkills` and exposes it in the visibility payload.
- `runtime/context-keys/skill-gate` reads `loadedSkills` to decide whether a tool invocation is permitted.
- `plugins/runtime-sync` may write initial `available`, `synced`, or `advertised` skill records at session start. It MUST NOT write the initial `loadedSkills` baseline unless it also performs Ravi-owned injection and observes completion.

## Failure Modes

- **Provider drops a skill silently** — adapters MUST detect this via the structured event stream when the provider exposes enough signal and emit a vector-correction event. Vector inconsistency after observed evidence is a bug, not a recoverable state.
- **Crash mid-load** — recovery MUST restore the vector from the last persisted state. A partially-loaded skill (acknowledged by the provider but not yet in the vector) MUST be re-added on recovery before the next turn.
- **Compact race** — if a tool invocation arrives during a compact, the runtime MUST resolve the vector reset before evaluating any skill-gate check. Tools MUST NOT see a transitional vector.
- **Provider cannot expose skill state** — the adapter MUST expose `unknown`/non-loaded records rather than fabricating loaded state. Capability consumers MUST treat unknown as not loaded for enforcement.

## Acceptance Criteria

- A new session reports an empty `loadedSkills` vector via `session-visibility`.
- Invoking a skill via the Skill tool causes the skill identifier to appear in the vector within one event boundary.
- Reading a skill through `ravi skills show <skill>` causes the canonical skill identifier to appear in `loadedSkills` within one tool completion boundary.
- A compact event resets the vector to empty in the next visibility query and emits a structured event documenting the reset.
- Vector content is identical regardless of which adapter the session is running under, given the same loaded skills.
- A synchronized Codex skill appears as `synced` or `advertised`, not `loaded`, until an observed loaded-skill signal is captured.
- A Pi session returns an empty `loadedSkills` vector and does not imply skill support until Pi exposes explicit skill state.
