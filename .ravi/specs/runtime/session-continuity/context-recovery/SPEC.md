---
id: runtime/session-continuity/context-recovery
title: "Runtime Context Recovery"
kind: feature
domain: runtime
capability: session-continuity
feature: context-recovery
capabilities:
  - session-continuity
  - context-recovery
  - replay
tags:
  - runtime
  - sessions
  - providers
  - codex
  - context-window
applies_to:
  - src/runtime/context-window-recovery.ts
  - src/runtime/host-event-loop.ts
  - src/runtime/credential-classifier.ts
  - src/runtime/session-dispatcher.ts
  - src/session-trace
owners:
  - ravi-dev
status: draft
normative: true
---

# Runtime Context Recovery

## Intent

Runtime Context Recovery lets Ravi recover when a provider cannot continue because its active context window is exhausted.

The first supported live case is Codex returning:

```text
Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.
```

Ravi must handle that as a provider-state failure, not as a user-facing task failure. The local SQLite session history and trace ledger remain the source of truth.

## Boundary

Ravi owns detection, provider-state reset, recovery prompt construction, trace events, and restart scheduling.

Providers own native compaction, thread/session ids, and raw error strings. Provider-specific strings may be classified by adapters or shared classifiers, but recovery policy must stay in the host runtime.

## Rules

- Context-window exhaustion MUST be classified from canonical `turn.failed` events or provider-local failure metadata.
- Codex-specific error text MAY seed the classifier, but the recovery flow MUST be provider-agnostic once the failure is classified.
- Recovery MUST clear provider session state only. It MUST NOT delete the Ravi session row, chat subscriptions, durable messages, prompt atom data, traces, tasks, or local history.
- Recovery MUST revoke live runtime context keys for the session so the next provider start receives fresh child CLI context.
- Recovery MUST NOT emit the raw provider error as the assistant response.
- Recovery MUST restart the session with a synthetic same-session prompt.
- The synthetic prompt MUST be plain text, compact, and human-readable. It MUST NOT be JSON.
- The synthetic prompt MUST include:
  - a clear recovery notice for the agent;
  - the latest user request from local history when available;
  - a compact recent transcript;
  - continuation instructions telling the agent not to treat historical messages as new requests.
- The synthetic prompt SHOULD warn the agent to inspect workspace state before repeating actions, because previous provider work may have already produced side effects.
- The recovery prompt MUST strip internal session surface headers, route hints, raw chat ids where possible, and message ids that are not useful to continue.
- The recovery prompt MUST be bounded by message count and total character budget.
- Recovery MUST record trace data showing the failure, reset, provider, model, classifier match, prompt size, and restart reason.
- If recovery prompt construction fails or no restart prompt can be built, Ravi MUST fail closed with a normal terminal failure.

## Provider Notes

### Codex

Codex currently exposes native thread controls, but a context-window exhaustion from a failed turn should be recovered by resetting provider state and starting a fresh provider thread with a compact recovery prompt.

Codex native compaction events are still preferred when they happen before failure. This feature handles the failure path where no successful native compaction occurred.

### Other Providers

Other providers should enter this recovery path only after their adapters or classifiers produce a context-window/context-limit classification. No provider-specific branching should be added to `bot.ts`, request building, or delivery routing.

## Acceptance Criteria

- A Codex `turn.failed` with the exact context-window error resets provider state and schedules a restart.
- The user does not receive `Error: Codex ran out of room...`.
- The next provider turn starts with `resume=false` because provider state was cleared.
- The restart prompt contains recent local history and the latest user request.
- The restart prompt is plain text and not JSON.
- The session trace includes `turn.failed` with `autoRecovered=true` and `session.context_window_exhausted`.
- Durable local messages remain readable after recovery.
- Credential retry logic does not treat context-window exhaustion as a credential retry.
