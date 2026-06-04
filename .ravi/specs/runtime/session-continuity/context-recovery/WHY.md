# Runtime Context Recovery Rationale

## Why Reset Provider State Only

The exhausted resource is the provider thread context, not the Ravi session. Deleting the Ravi session would also risk losing route bindings, chat participation, trace continuity, task state, and local history needed to resume safely.

`resetSession` is the right primitive because it clears provider ids, runtime params, token counters, compaction counters, and system-sent state while preserving the local session identity.

## Why Not Ask The User To Retry

The user already sent the latest instruction. If Ravi can reconstruct enough context from local history, it should continue without asking the user to manually repeat the request. A visible "please send again" response is only a fallback when automatic recovery cannot build a faithful-enough continuation prompt.

## Why A Plain Text Recovery Prompt

The recovery prompt is consumed by a model as the first message in a fresh provider thread. Plain text spends fewer tokens than JSON, reads better in traces, and avoids the model mistaking a structured blob for tool input. The prompt should be compact, direct, and clearly separate recovered history from the latest actionable request.

## Why Keep This Provider-Agnostic

Codex exposed the bug first, but context-window exhaustion is a general provider failure class. The host runtime should recover from the classification, while adapters and classifiers normalize each provider's native wording into that class.

Provider-native compaction remains useful. This feature is the fallback after compaction fails, does not happen, or the provider reports a hard context-window failure.
