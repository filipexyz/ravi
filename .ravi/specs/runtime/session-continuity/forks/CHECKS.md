# Runtime Session Forks Checks

## Planner Unit Tests

- Builds a `rebase_current` plan for a message edit.
- Replaces the original atom with the edited atom.
- Preserves later atoms in order.
- Excludes assistant outputs after the edited atom from authoritative replay state.
- Marks replay as `lossy` when only plain text transcript replay is available.
- Fails closed when the edit target message id has no atom.

## Dispatcher Tests

- Edit rebase aborts the live runtime session.
- Pending messages are not lost during rebase.
- Dirty workspace produces an authorization instruction before any new file changes.
- Provider state reset does not delete prompt atoms.

## Provider Tests

- Claude maps latest-state native fork only where supported.
- Codex native `thread.fork` remains runtime control while `supportsSessionFork=false`.
- Codex materializer, when implemented, forks child then rolls back child without mutating parent.
- Pi native fork/clone remains unavailable as canonical fork until its materializer is implemented.
- Replay fallback starts fresh provider state and includes a labeled transcript.

## End-To-End Regression

- Live WhatsApp edit test preserves `senha: 132` after editing an earlier message.
- Debounced multi-message prompt can rebase from the first atom and replay the remaining atoms.
- Session trace explains strategy, atom ids, and provider state before/after.
