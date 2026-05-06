---
id: runtime/session-continuity/forks
title: "Runtime Session Forks"
kind: feature
domain: runtime
capability: session-continuity
feature: forks
capabilities:
  - session-continuity
  - fork
  - replay
  - message-edits
tags:
  - runtime
  - sessions
  - forks
  - message-edits
  - provider-contract
applies_to:
  - src/runtime/types.ts
  - src/runtime/runtime-session-continuity.ts
  - src/runtime/runtime-request-builder.ts
  - src/runtime/session-dispatcher.ts
  - src/runtime/codex-provider.ts
  - src/runtime/claude-provider.ts
  - src/runtime/pi-provider.ts
  - src/omni/consumer.ts
  - src/cli/commands/sessions-runtime.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Runtime Session Forks

## Intent

Ravi must support forking or rebasing a runtime session from any meaningful point in the Ravi prompt stream, regardless of provider. "Any meaningful point" means any prompt atom boundary. Provider-native turn or thread boundaries are optimizations only when they align with prompt atoms.

Message edits are the first required use case: when a previous channel message is edited, Ravi must replace the original prompt atom, rebuild the session from that point, and preserve later conversation atoms.

## Canonical Fork Request

A canonical fork request MUST include:

- `sessionKey`: source Ravi session.
- `mode`: `branch` or `rebase_current`.
- `forkPoint`: the desired cursor.
- `patch`: optional replacement, insertion, or deletion of prompt atoms.
- `target`: child session identity for `branch`, or current session for `rebase_current`.
- `reason`: e.g. `message_edit`, `manual_branch`, `task_experiment`, `provider_recovery`.
- `source`: actor/channel/task metadata for audit.

Fork point kinds SHOULD include:

- `before_atom`
- `after_atom`
- `before_turn`
- `after_turn`
- `provider_cursor`
- `latest`

`before_atom` and `after_atom` are the canonical precise forms. Other forms MUST be converted to atom boundaries when possible.

## Canonical Fork Plan

The planner MUST produce a `RuntimeForkPlan` before touching provider state. A plan SHOULD include:

- stable plan id.
- source session key/name.
- target session key/name.
- provider id and model settings.
- cwd and environment signature.
- fork point and resolved atom boundary.
- prefix atom ids.
- replacement atom ids.
- suffix atom ids.
- assistant turn ids included in replay.
- materialization strategy.
- expected provider state mutation, if any.
- degradation level: `exact`, `near_exact`, `lossy`, or `unavailable`.

Ravi MUST trace the plan before materialization.

## Materialization Strategies

### Exact Native Fork

Allowed only when the provider can fork at the resolved atom boundary without mutating the parent. The child/rebased session MUST persist a new provider session state.

### Native Fork Plus Rollback

Allowed when the provider can copy a parent thread and roll back only the child. Ravi MUST NOT roll back the parent session. If the target atom is inside a provider turn, the child must roll back to the previous turn boundary and Ravi must replay the atom suffix.

### Replay Fork

Allowed for any provider that can start a fresh session. Ravi constructs a replay transcript from prompt atoms and assistant outputs. Replay MUST preserve source boundaries in the prompt so the provider can distinguish old transcript from the new user instruction.

Replay is exact only when the provider accepts structured user/assistant history. Plain text transcript replay is `lossy` unless the product explicitly accepts it for that operation.

### Hybrid Fork

Allowed when a provider-native checkpoint exists before the requested atom boundary. Ravi materializes the checkpoint and replays the atom suffix.

### Reset Replay

Used by message edit rebase when current provider state is invalidated. Ravi clears current provider state, then materializes the fork plan into the same session.

## Message Edit Semantics

When an edit event targets a previously processed source message:

- Ravi MUST resolve the original source message id to a prompt atom.
- Ravi MUST create a replacement atom from the edited content.
- Ravi MUST exclude the superseded original atom from replay.
- Ravi MUST preserve all later atoms in original order unless the user explicitly discards them.
- Ravi MUST preserve later assistant outputs only when they still correspond to the replayed atom prefix. Assistant outputs after the edited atom SHOULD be treated as invalidated unless a product mode explicitly includes them as historical transcript.
- Ravi MUST not answer the next user prompt from a provider state that only contains the edited message.

If the original message id cannot be resolved to an atom, Ravi MUST fail closed or use an explicitly traced degraded replay from available chat history. It MUST NOT claim the conversation was faithfully rebuilt.

## Provider Requirements

### Claude

Claude currently supports native resume and `forkSession` at provider session level. Canonical arbitrary fork MUST NOT assume Claude can fork at old prompt atom boundaries unless the SDK exposes and tests that cursor.

Claude MAY use native `forkSession` for latest-state branch operations. Historical message edits SHOULD use Ravi replay or a future Claude materializer that proves exact cursor support.

### Codex

Codex exposes `thread.fork`, `thread.read`, and `thread.rollback` as native runtime controls. These controls are not yet canonical session fork support.

Codex MAY become a canonical fork provider by implementing a materializer that:

- forks the parent thread without mutating it.
- rolls back the child thread to a requested provider turn when needed.
- maps provider turns to Ravi prompt atom ids.
- replays atom suffixes after rollback.
- persists the new child/rebased thread id and cwd.

Until then, `supportsSessionFork` MUST remain false for Codex even though `thread.fork` exists.

### Pi

Pi has native `fork`/`clone` concepts but they MUST remain outside canonical Ravi fork until file-backed session semantics, cwd validation, parent/child persistence, and atom replay are mapped and tested.

Pi MAY support replay fork before native fork if it can accept a transcript prompt safely.

## Runtime API Requirements

The runtime contract SHOULD grow structured fork types instead of a boolean `forkSession`:

- `RuntimeForkRequest`
- `RuntimeForkPoint`
- `RuntimeForkPatch`
- `RuntimeForkPlan`
- `RuntimeForkMaterializationResult`

Provider capabilities SHOULD grow structured fork capability fields:

- supported fork point kinds.
- native copy support.
- child rollback support.
- replay support.
- active-turn fork support.
- transcript history mode.

The sessions CLI SHOULD expose canonical fork/rebase operations separately from provider-native runtime controls:

- `ravi sessions fork <session> ...` for canonical branch.
- `ravi sessions rebase <session> ...` for canonical replacement of current state.
- `ravi sessions runtime fork <session>` remains provider-native control/debug until migrated.

## Observability

Fork/rebase traces MUST answer:

- Why did Ravi fork or rebase?
- What source message, atom, or turn was the cut point?
- Which atoms were replayed?
- Which provider strategy was used?
- Was the materialization exact or degraded?
- What provider state existed before and after?
- Did workspace dirtiness require user authorization?

## Acceptance Criteria

- Rebase after a message edit passes the `senha: 132` regression.
- A debounced prompt containing three source messages can be rebased after the first atom and preserve atoms two and three.
- Codex native `thread.fork` cannot be invoked as canonical session fork until the materializer persists the child thread as Ravi provider state.
- `ravi sessions trace` can show fork/rebase plan id, strategy, atom ids, and provider state before/after.
- No provider-specific fork branch is added to `bot.ts`.
