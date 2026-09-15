# Runtime Session Continuity Checks

## Prompt Atom Ledger

- Inbound channel messages create one prompt atom before debounce or provider batching.
- Debounced prompts keep all atom ids in order.
- Provider-native steering records the steered atom id even when it bypasses `pendingMessages`.
- System commands, task dispatch prompts, and observer prompts create typed atoms.
- Message edits create replacement atoms and link to the superseded source message id.
- Reset does not delete prompt atoms.

## Turn Mapping

- `adapter.request` records the ordered prompt atom ids yielded in the provider turn.
- A provider turn containing multiple prompt atoms can be replayed from any atom boundary.
- Assistant outputs are correlated to provider turn ids.
- Provider session id before/after is recorded for resume, fork, and replay materialization.

## Message Edit Regression

- Send `legal`.
- Send `senha: 132`.
- Ask `lembra da senha?` and verify `132`.
- Edit `legal` to `legal v2`.
- Ask `lembra da senha?` again.
- Expected: the restarted session still answers `132`, because the rebase preserved later prompt atoms.

## Provider Strategy

- Claude native `forkSession` is used only for fork points it can represent.
- Codex `thread.fork` is not advertised as canonical fork until parent/child mapping and rollback/replay are implemented.
- Pi fork/clone commands are not advertised as canonical fork until file-backed state mapping is implemented.
- Replay fallback works for all providers that can accept a fresh prompt, but trace records whether replay was lossy.
- Ambiguous delivery recovery preserves compatible provider session state and reconciles the stable logical delivery id before replay.
- Provider-local recovery forks do not advertise canonical fork support.

## Safety

- Dirty workspace during rebase causes the agent to ask for keep/revert authorization before modifying files.
- Rebase does not silently discard pending messages.
- Rebase preserves actor metadata and source message ids.
- Rebase fails closed when the target message id cannot be matched to a prompt atom.
- Repeated inactivity recovery is bounded and cannot resend the same logical delivery indefinitely.
- After daemon restart, resume MUST pick last-used / snapshot provider when no explicit override is present.
- Stored provider session ids MUST remain when agent or global default differs from last-used.
- Stored provider session ids MUST clear only on an explicit provider change.
- A `/login` or `Not logged in` stub MUST be recorded as `turn.failed` and MUST NOT persist on the session transcript.
