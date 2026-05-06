# Runtime Session Continuity Runbook

## Debugging A Lost Context After Reset

1. Read the session trace for the edited message or reset event:

```bash
ravi sessions trace <session> --message <message_id> --explain
```

2. Confirm whether `adapter.request` used `resume=false`.
3. Check whether the prompt preview includes only the edit notice or a replay transcript.
4. Read durable history:

```bash
ravi sessions read <session> -n 40
```

5. If later chat messages exist in history but not in the restarted provider prompt, classify the bug as missing continuity replay.
6. If the original edited message appears alongside the edited version with no supersession metadata, classify the bug as missing prompt atom edit modeling.
7. If actor metadata is `unknown` on an edit event, classify separately as edit actor resolution failure.

## Choosing A Fork Strategy

1. Identify the fork point: source message id, prompt atom id, provider turn id, or provider cursor.
2. Resolve the provider and capability matrix.
3. Prefer exact native fork only when the provider declares support for that fork point kind.
4. If native fork is only turn-level and the requested fork point is inside a turn, fork or rollback to the previous safe turn and replay atom suffix.
5. If native fork is unavailable, build a replay fork from Ravi prompt atoms and assistant turn outputs.
6. If replay data is incomplete, fail closed or ask the operator whether to accept degraded replay.

## Message Edit Rebase

1. Detect edit event from Omni.
2. Resolve the target source message id to an existing prompt atom.
3. Create a replacement atom with `supersedes_source_message_id`.
4. Build a rebase plan:
   - prefix atoms before the edited atom.
   - replacement atom.
   - suffix atoms after the original atom, excluding superseded original atom.
5. Inspect workspace state.
6. If dirty, the restarted agent prompt MUST ask whether to keep or revert file edits before making more file changes.
7. Abort the live runtime session.
8. Materialize the fork/rebase using provider strategy.
9. Persist new provider state and trace the plan/materialization.
10. Ask the follow-up question against the rebased provider state.

## Trace Events To Add

Future implementation SHOULD emit:

- `runtime.fork.requested`
- `runtime.fork.planned`
- `runtime.fork.materialized`
- `runtime.fork.failed`
- `runtime.rebase.requested`
- `runtime.rebase.materialized`
- `runtime.replay.started`
- `runtime.replay.completed`

Each event SHOULD include a fork plan id, fork point, strategy, provider, cwd, source message id, atom ids, and degradation level.
