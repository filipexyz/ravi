# Runtime Session Forks Runbook

## Live Message Edit Validation

1. Send a baseline message:

```text
legal
```

2. Send a later memory-bearing message:

```text
senha: 132
```

3. Ask:

```text
lembra da senha?
```

Expected: `132`.

4. Edit `legal` to `legal v2`.
5. Ask again:

```text
lembra da senha?
```

Expected after canonical rebase: `132`.

If the answer comes from global credentials or says it does not know, the rebase did not replay later atoms.

## Debugging A Fork/Rebase

```bash
ravi sessions trace <session> --message <edit_event_id> --explain
ravi sessions trace <session> --only dispatch --since 10m
ravi sessions trace <session> --only adapter --since 10m
ravi sessions read <session> -n 80
```

Look for:

- `channel.message.edited`
- fork/rebase trace events.
- `adapter.request resume=false` with replay content.
- atom ids in trace payload.
- provider session id before/after.

## Codex Native Fork Debug

Provider-native command:

```bash
ravi sessions runtime fork <session> --json
```

This is not canonical Ravi fork today. Use it only to inspect native behavior. Canonical implementation must persist the returned child thread id through a Ravi fork plan.

## Failure Classification

- `edit-event-without-atom`: edit target did not resolve to a prompt atom.
- `rebase-without-suffix`: edited atom was replayed but later atoms were not.
- `turn-boundary-only`: provider can fork turns but requested atom was inside a turn.
- `native-fork-parent-mutated`: provider rollback or fork altered parent state.
- `lossy-replay`: Ravi replayed a plain text transcript because structured provider history was unavailable.
- `dirty-workspace-blocked`: workspace changes require user keep/revert authorization before continuing.
