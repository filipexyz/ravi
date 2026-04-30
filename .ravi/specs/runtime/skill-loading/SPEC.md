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

- Each runtime session MUST own a `loadedSkills` vector — an ordered set of skill identifiers loaded into the live provider context.
- The vector MUST start empty at session creation. A session MUST NOT inherit a non-empty `loadedSkills` from any previous session.
- A skill enters the vector when:
  - It is auto-discovered and invoked by the harness (Skill tool invocation), or
  - The runtime explicitly injects the skill (e.g. via the skill-gate auto-load flow, when implemented).
- A skill exits the vector only via a vector reset (compact or new session). A loaded skill MUST NOT be silently evicted.
- The vector MUST be reset to empty on:
  - Session creation.
  - Compaction (auto or manual).
  - Explicit `session reset` invocations.

## Rules

- The vector MUST be persisted alongside the session record so crash recovery and dispatch reuse can reconstruct state without scraping provider events.
- Vector mutations (add, reset) MUST emit structured events on the runtime event stream so observability can replay the timeline.
- The skill identifier in the vector MUST be the canonical skill name (frontmatter `name`), not a path or alias. Discovery and gating use the same identifier surface.
- The vector MUST be readable from a child Ravi context so tools running under `RAVI_CONTEXT_KEY` can introspect it without elevated permissions.
- Every adapter (Claude Code, Codex, Pi) MUST report skill-loading consistently. If a provider exposes a different mechanism for "skill in context", the adapter MUST translate it into the same vector shape before exposing it.
- Compaction MUST NOT preserve `loadedSkills`. Even if the underlying provider keeps the textual content of a skill across compaction, the runtime MUST treat compaction as a fresh skill-loading window so gates re-evaluate correctly.

## Interaction with Other Capabilities

- `runtime/session-visibility` reads `loadedSkills` and exposes it in the visibility payload.
- `runtime/context-keys/skill-gate` reads `loadedSkills` to decide whether a tool invocation is permitted.
- `plugins/runtime-sync` writes the initial `loadedSkills` baseline at session start (when sync is implemented). Until then, sessions begin with an empty vector and skills load lazily.

## Failure Modes

- **Provider drops a skill silently** — adapters MUST detect this via the structured event stream and emit a vector-correction event. Vector inconsistency is a bug, not a recoverable state.
- **Crash mid-load** — recovery MUST restore the vector from the last persisted state. A partially-loaded skill (acknowledged by the provider but not yet in the vector) MUST be re-added on recovery before the next turn.
- **Compact race** — if a tool invocation arrives during a compact, the runtime MUST resolve the vector reset before evaluating any skill-gate check. Tools MUST NOT see a transitional vector.

## Acceptance Criteria

- A new session reports an empty `loadedSkills` vector via `session-visibility`.
- Invoking a skill via the Skill tool causes the skill identifier to appear in the vector within one event boundary.
- A compact event resets the vector to empty in the next visibility query and emits a structured event documenting the reset.
- Vector content is identical regardless of which adapter the session is running under, given the same loaded skills.
