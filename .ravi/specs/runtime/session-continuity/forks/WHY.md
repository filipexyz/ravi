# Runtime Session Forks Rationale

## Why This Feature Exists

Message edits change the past. If Ravi simply aborts the provider and sends the edited message as the next prompt, the provider loses the messages that happened after the edited message. That is exactly what happened in the live edit test: the edited `legal v2` prompt started fresh, and later `senha: 132` was not present in provider context.

Fork/rebase lets Ravi rebuild the session as if the edit had been present from the beginning.

## Why Atom Boundary Is The Minimum

Provider prompts are not always one chat message. Ravi may combine messages because of debounce, delivery barriers, or provider-native steering. The user-visible operation, however, targets one channel message. Therefore the canonical fork point has to be the prompt atom, not the provider prompt string.

Arbitrary byte offsets inside an atom are not required. A message edit replaces the whole source message atom.

## Why Assistant Outputs After The Edit Are Invalidated

Assistant outputs after an edited message may depend on the original content. Replaying them as if they were still authoritative can preserve incorrect state. They may be included as labeled historical transcript only in degraded modes, but they should not be treated as fresh provider state after rebase.

## Why Provider Native Control Stays Separate

Codex can fork a native thread today. That is useful for debugging, but it does not automatically satisfy Ravi fork semantics. Ravi still needs to know which source messages are in that thread, which atom boundary was requested, whether rollback mutates parent or child, and how to persist the resulting provider state.

Native control becomes canonical fork only after that mapping exists.
