---
id: runtime/session-visibility
title: "Runtime Session Visibility"
kind: capability
domain: runtime
capability: session-visibility
tags:
  - runtime
  - sessions
  - observability
  - tokens
  - compact
  - skills
applies_to:
  - src/runtime
  - src/cli/commands/sessions.ts
  - src/cli/commands/context.ts
  - src/runtime/runtime-event-loop.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Runtime Session Visibility

## Intent

`session-visibility` exposes the live state of the current runtime session to the CLI and to other Ravi tools so that operators and agents can reason about budget, compaction proximity, and which skills are loaded right now. The capability is provider-agnostic: every adapter (Claude Code, Codex, Pi) MUST surface the same shape of state.

The capability exists because today the operator has no way to ask "how close is this session to auto-compact?", "what is the token consumption?", or "which skills are currently in this session's context?" without scraping provider-specific output.

## State Shape

A session-visibility query MUST return a structured payload with at least:

- `sessionKey` — the Ravi runtime session identifier.
- `agentId` — the agent the session belongs to.
- `provider` — adapter name (e.g. `claude-code`, `codex`, `pi`).
- `tokens.used` — tokens consumed in the current session window.
- `tokens.limit` — provider-declared limit before auto-compact.
- `tokens.remaining` — `limit - used`, or `null` if the provider does not expose a limit.
- `compact.threshold` — the proportion of `limit` at which the runtime triggers auto-compact (provider default or operator override).
- `compact.willCompactAt` — projected token count that will trigger auto-compact for the current session.
- `compact.lastCompactedAt` — timestamp of the most recent compact for this session, or `null`.
- `skills` — per-skill visibility records with `state`, `confidence`, `source`, and `evidence` (see `runtime/skill-loading`).
- `loadedSkills` — compatibility vector of skill identifiers currently loaded with observed evidence (see `runtime/skill-loading`).
- `lastUpdatedAt` — timestamp of the most recent state refresh.

`loadedSkills` is a projection, not the canonical evidence store. New consumers SHOULD read `skills` so they can distinguish `available`, `synced`, `advertised`, `requested`, `loaded`, `stale`, and `unknown` states.

## Rules

- The capability MUST be exposed as a CLI surface (`ravi sessions visibility <session>` or equivalent canonical command) returning JSON when invoked with `--json`.
- The capability MUST also be exposed as a runtime context key so child CLIs running under a Ravi context can fetch their own session's visibility state without additional permissions.
- Every adapter MUST report the same state shape. Adapters that lack a value (e.g. a provider that does not surface a token limit) MUST report `null` for that field rather than omitting it.
- The state MUST be refreshed at least at every provider event boundary (turn complete, tool call complete, compaction event) and on explicit operator query.
- Visibility queries MUST NOT mutate session state. They are read-only and MUST be safe to call from any tool.
- The capability MUST tolerate stale data: if the most recent refresh failed, the response MUST include `lastUpdatedAt` so consumers can detect staleness.
- The capability MUST NOT claim a skill is loaded from discovery, local sync, prompt catalog text, UI mention, or approval request alone.
- A successful Ravi-owned skill read command (`ravi skills show <skill>`) MAY be surfaced as loaded when the runtime records `tool-call` evidence for the canonical skill id.
- Provider gaps MUST be visible in the payload as `skills[].state=unknown` or by leaving `loadedSkills` empty. Consumers MUST NOT infer `loaded` from provider name.
- Compatibility clients that only read `loadedSkills` MUST see a conservative view: unknown or merely advertised skills are omitted.

## Failure Modes

- **Provider does not expose tokens** — `tokens.used` and `tokens.limit` MUST be `null`. Consumers MUST handle this gracefully without assuming the session is unbounded.
- **Compaction event mid-query** — the response MUST reflect the post-compact state, with `compact.lastCompactedAt` updated and `loadedSkills` reset per `runtime/skill-loading`.
- **Session not found** — return a structured error, not an empty payload; consumers MUST distinguish "no session" from "session with zero tokens".
- **Provider does not expose skill loading** — return the normal visibility shape with conservative skill state. For Codex this may include `synced` or `advertised`; for Pi this is currently `unknown` or empty. Do not synthesize `loaded`.

## Acceptance Criteria

- A session under each supported provider returns a populated visibility payload with the same JSON shape.
- The same payload is reachable via the CLI surface and via a runtime context key, returning identical content.
- Compact events update `compact.lastCompactedAt` and reset `loadedSkills` to empty in the next visibility query.
- Visibility responses are sub-100ms p95 in steady state (no provider round-trip required for cached state).
- A Codex session with synchronized Ravi skills exposes those skills in `skills` but does not include them in `loadedSkills` until observed load evidence exists.
- A Pi session exposes the skill fields without pretending to support skill loading.
