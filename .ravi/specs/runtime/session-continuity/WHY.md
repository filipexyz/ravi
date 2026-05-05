# Runtime Session Continuity Rationale

## Why Ravi Owns Continuity

Providers expose different continuity primitives:

- Claude has provider session ids and native `forkSession`.
- Codex has app-server thread ids plus native thread controls.
- Pi has file-backed sessions and native fork/clone commands.

Those primitives are useful, but they do not define Ravi semantics. Ravi sessions are tied to chats, actors, routes, tasks, command expansions, delivery barriers, traces, and permission scope. Provider-native history cannot be the source of truth for those product semantics.

## Why Prompt Atoms

The message edit test exposed the gap. Resetting provider state and sending only the edited message created a clean provider thread, but lost later chat context.

Turn-level fork is also insufficient. Ravi may combine several messages into one provider prompt through debounce, queue release, or provider-native steering. Forking at the provider turn boundary cannot represent "replace only the first message inside this combined prompt, then replay the rest".

Prompt atoms are the smallest unit Ravi can reason about consistently across providers.

## Why Not Use Chat History Alone

The chat DB currently stores rendered user/assistant messages and message metadata. That helps with `sessions read`, but it is not a complete runtime replay log:

- It may contain already-combined prompts instead of original atom boundaries.
- It does not explicitly record replacement/supersession for edited messages.
- It does not always correlate user atoms to provider turn ids.
- It does not carry all delivery, task barrier, command, and actor metadata as structured replay state.

A prompt atom ledger avoids reconstructing runtime state from display-oriented history.

## Why Native Fork Is Only A Strategy

Native fork can be exact and cheap when the provider supports the requested boundary. It can also be wrong:

- It may fork only the latest provider state.
- It may mutate the parent.
- It may not support rollback to an old turn.
- It may not understand a Ravi prompt atom inside a batched provider turn.

The host must plan a canonical Ravi fork first, then choose a materialization strategy.

## Why Rebase Is Separate From Branch

Message edit is not just "make a new child thread". The channel conversation has changed. The current session should behave as if the edited message replaced the original message, with later messages preserved.

That is a rebase of the current Ravi session, not a branch for exploration.
