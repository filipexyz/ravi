---
id: runtime/session-continuity
title: "Runtime Session Continuity"
kind: capability
domain: runtime
capability: session-continuity
capabilities:
  - session-continuity
  - resume
  - fork
  - replay
tags:
  - runtime
  - sessions
  - providers
  - prompt-ledger
applies_to:
  - src/runtime/runtime-session-continuity.ts
  - src/runtime/runtime-request-builder.ts
  - src/runtime/session-resolver.ts
  - src/runtime/session-dispatcher.ts
  - src/runtime/host-event-loop.ts
  - src/runtime/types.ts
  - src/db.ts
  - src/session-trace
owners:
  - ravi-dev
status: draft
normative: true
---

# Runtime Session Continuity

## Intent

Runtime session continuity defines how Ravi carries conversation state across provider restarts, provider changes, message edits, chat threads, daemon restarts, and explicit branch/fork operations.

Ravi owns the canonical continuity model. Provider-native session ids, thread ids, files, and control operations are materialization strategies only.

## Terms

- **Provider session state**: opaque provider state persisted by Ravi from canonical `turn.complete`, such as a Claude session id, Codex thread id, or Pi file-backed session params.
- **Prompt atom**: the smallest Ravi-owned replayable input unit before provider batching, debounce, steering, or concatenation. One inbound channel message, system command, task dispatch prompt, edited-message notice, or observer event SHOULD become one prompt atom.
- **Provider turn**: one provider request produced by the runtime prompt generator. A provider turn MAY contain several prompt atoms if Ravi batched them.
- **Fork point**: a stable cursor into Ravi continuity, such as before/after a prompt atom, before/after a provider turn, or a provider-native cursor when it can be mapped back to Ravi atoms.
- **Fork materialization**: the provider-specific work needed to create a runtime state matching a canonical Ravi fork plan.
- **Replay**: provider-agnostic reconstruction from Ravi prompt atoms and durable assistant outputs when no native provider fork can represent the requested fork point.
- **Rebase**: replacing the current session state with a forked/replayed state, used for message edits.
- **Branch**: creating a separate child session without replacing the parent session state.

## Current Baseline

Current code has partial continuity:

- `resolveRuntimeSessionContinuity()` chooses resume or parent-thread fork from stored provider state.
- `RuntimeStartRequest` carries `resume`, `resumeSession`, and boolean `forkSession`.
- `supportsSessionFork` is a legacy boolean capability.
- Claude maps `forkSession` into native query options.
- Codex exposes native `thread.fork` as runtime control but does not advertise canonical `supportsSessionFork`.
- Pi has native fork/clone concepts but keeps canonical fork disabled.
- Message edit restart currently resets provider state and publishes only the edited message prompt. It does not rebuild the later conversation.

This baseline is not enough for message edits or arbitrary prompt-history forks.

## Invariants

- Ravi MUST treat prompt atoms as the canonical replay boundary. Provider turns and provider threads are not precise enough when prompts are debounced, steered, or concatenated.
- Ravi MUST persist enough prompt atom metadata to replay or rebase a session without depending on provider transcripts.
- Ravi MUST record which prompt atoms were yielded to each provider turn.
- Ravi MUST record assistant outputs with enough turn/atom correlation to build a replay transcript when native fork is unavailable.
- Provider-native fork MUST NOT be exposed as canonical Ravi fork until it can be mapped to Ravi fork points, persistence, traces, and parent/child session state.
- `supportsSessionFork` MUST mean "this provider can materialize a Ravi fork plan for at least one declared fork point type", not merely "the provider has a native command named fork".
- A provider that supports resume MUST validate cwd/provider compatibility before using stored provider state.
- A provider that supports fork MUST define how parent provider state maps into the child or rebased session.
- Reset MUST clear provider state only. It MUST NOT delete the durable prompt atom ledger or chat history needed for replay.
- Rebase after message edit MUST preserve later user messages unless the user explicitly asks to discard them.
- Rebase after message edit MUST preserve actor metadata, source message ids, command metadata, attachments, and delivery provenance for replayed atoms.
- If workspace state is dirty before a rebase, Ravi MUST ask the user whether to keep or revert local file edits before the agent modifies files again.
- Fork/rebase operations MUST be traceable through session trace events and final adapter requests.
- Fork/rebase operations MUST fail closed with a visible reason if Ravi cannot build a faithful-enough fork plan.
- Daemon restart resume events MUST preserve pending prompt atoms and queued user messages. They MUST NOT clear, reorder, or replace pending work.
- Runtime continuity after daemon restart MUST obey `daemon/restart/active-session-resume`: only non-idle sessions with eligible activity inside the 1 hour restart resume window are automatically resumed.

## Required Data Model

Ravi SHOULD add a durable prompt atom ledger. A prompt atom record MUST include:

- `atom_id`: stable Ravi id.
- `session_key` and `session_name`.
- `agent_id`.
- `kind`: channel message, system command, task dispatch, observer event, edited message, synthetic replay notice, or other runtime-owned input.
- `source_message_id` when the atom came from a channel message.
- `supersedes_atom_id` or `supersedes_source_message_id` when an edit replaces a previous atom.
- rendered prompt text exactly as sent to the runtime queue.
- raw normalized content before envelope rendering when available.
- `source` and `context` JSON, including actor metadata.
- command metadata.
- delivery barrier and task barrier metadata.
- `created_at` and source timestamp.
- optional media/attachment references.

Ravi SHOULD add a provider-turn mapping table. Each mapping MUST record:

- provider turn id and session trace turn id.
- ordered prompt atom ids yielded in that turn.
- combined prompt hash and system prompt hash.
- provider session id before and after.
- resume/fork/replay flags and fork plan id when present.

Assistant outputs SHOULD be correlated to provider turns. Replay can then use either provider-native state or a Ravi transcript of user atoms plus assistant outputs.

## Continuity Strategies

Ravi MAY materialize continuity with these strategies:

- **Resume**: use stored provider session state after provider/cwd validation.
- **Native fork**: ask the provider to copy a parent provider session/thread at a mapped fork point.
- **Native fork plus rollback**: fork a provider-native thread, roll back only the child, then replay suffix atoms.
- **Replay fork**: start a fresh provider session and inject a transcript built from prompt atoms and assistant outputs.
- **Hybrid fork**: use the nearest safe provider-native checkpoint, then replay atoms after that checkpoint.
- **Reset replay**: clear current provider state and replay the canonical transcript into the same Ravi session.

Ravi MUST choose the most faithful strategy available from provider capabilities and the requested fork point. It MUST NOT silently degrade from exact native fork to lossy replay without recording the degradation in trace.

## Provider Contract Requirements

Provider adapters MUST declare structured fork behavior before canonical fork is enabled:

- supported fork point kinds.
- whether active turns can be forked.
- whether provider state can be copied without mutating the parent.
- whether child rollback is available.
- whether the provider accepts transcript replay as structured conversation history or only as a plain text prompt.
- which provider state fields are persisted after materialization.

The legacy `forkSession?: boolean` on `RuntimeStartRequest` SHOULD be replaced or wrapped by a structured `RuntimeForkRequest`.

## Acceptance Criteria

- Editing an earlier channel message MUST rebuild the session so later channel messages remain available to the next turn.
- If a user sends `senha: 132`, then edits an earlier unrelated message, the restarted session MUST still answer `132` when asked for the password from conversation context.
- A debounced provider turn containing multiple prompt atoms MUST support fork/rebase at each atom boundary.
- Codex native `thread.fork` MUST remain runtime control only until a canonical fork materializer maps it to prompt atoms and session state.
- Pi native fork/clone MUST remain disabled for canonical Ravi fork until its file/session semantics are mapped and tested.
- Session trace MUST explain whether the materialization was resume, native fork, native rollback, replay, hybrid, or reset replay.
