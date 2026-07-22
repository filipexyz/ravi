# Runtime Context Recovery Rationale

## Why Reset Provider State Only

The unavailable resource is provider-owned thread state, whether it was exhausted or deleted from local provider storage. It is not the Ravi session. Deleting the Ravi session would also risk losing route bindings, chat participation, trace continuity, task state, and local history needed to resume safely.

`resetSession` is the right primitive because it clears provider ids, runtime params, token counters, compaction counters, and system-sent state while preserving the local session identity.

## Why Not Ask The User To Retry

The user already sent the latest instruction. If Ravi can reconstruct enough context from local history, it should continue without asking the user to manually repeat the request. A visible "please send again" response is only a fallback when automatic recovery cannot build a faithful-enough continuation prompt.

## Why A Plain Text Recovery Prompt

The recovery prompt is consumed by a model as the first message in a fresh provider thread. Plain text spends fewer tokens than JSON, reads better in traces, and avoids the model mistaking a structured blob for tool input. The prompt should be compact, direct, and clearly separate recovered history from the latest actionable request.

## Why Keep This Provider-Agnostic

Codex first exposed context-window exhaustion; Claude exposed missing provider-native state. The host runtime should recover from either classification, while adapters and classifiers normalize each provider's native wording.

Provider-native compaction remains useful. This feature is the fallback after compaction fails, does not happen, or the provider reports a hard context-window failure.

## Why Missing-Session Recovery Is Bounded

`No conversation found` is recoverable only when Ravi actually supplied stored provider state. Clearing that state changes the next start to `resume=false`, so one retry is enough. If a fresh start reports the same error, Ravi surfaces the failure normally rather than repeatedly recreating the session.
