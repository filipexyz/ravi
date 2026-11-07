# Runtime Session Continuity Checks

- `bun test src/runtime/thread-provider-config.test.ts` MUST exercise an active
  host event loop and its next-turn resolver: newer provider configuration wins
  over late completion, while compatible native continuity/output/usage survive.
- The same regression MUST dispatch the actual next prompt through
  `RuntimeSessionDispatcher`, covering clear, explicit override, compatible
  reuse, unchanged launch overrides and a configuration change across an await.
- Queue a successor before clear while the old turn is active: complete that
  turn, preserve the successor, and select the new provider without replaying
  the completed prompt or starting the successor on the old handle.
- Cover all three orderings: clear/successor/terminal, successor/clear/terminal,
  and clear/terminal/successor. Deferred barriers keep the real durable attempt
  running until its canonical terminal; immediate delivery retains its meaning.
- Suspend old terminal accounting, consume its successor through a replacement's
  real generator, then finish the old terminal: no second copy enters the stash.
- Replace the slot across model-switch, terminal-feedback and recovery awaits:
  old cleanup cannot remove/reset the replacement or overwrite its native/context
  state; old-turn accounting remains recorded exactly once.
- Exercise complete, generic non-recoverable failure, and interruption with
  incompatible clear, compatible clear and unchanged configuration. The old
  attempt keeps its terminal status and every successor is consumed once.
- Run `after_task` through the real generator with an active task in disposable
  storage: no successor input is yielded until task release, including after
  failure/interruption. Keep replay-safe interrupted input ahead of successors,
  preserve legitimate recovery paths, and never resurrect cancelled work.
- Derive Codex's pending tool-result-delivery barrier from canonical
  `tool.started` and `tool.completed` events, then request a real dispatcher
  abort before a recoverable failure. No recovery branch may restart B;
  a later explicit C delivers B and C once without replaying A. Keep controls
  for suppressed, credential and context recovery without an explicit abort.
- Pause canonical terminal emission with a real Codex tool-result abort pending,
  then expire the real tool lease. Cancellation retains dormant B until a fresh
  C admission; no inactivity notice or automatic restart may replace it. Cover
  an unchanged lease, no-abort recovery, and replacement ownership across the
  await without changing the accepted terminal's accounting.
- Compose approved context recovery with native Slack output delivery: no
  premature safe-error manifest, the recovered final is delivered when allowed,
  and cooldown still suppresses it. Replace the runtime while broker feedback
  awaits and verify the old recovery cannot reset or revoke the replacement.
- Abort or replace the runtime while credential refresh awaits: the retired
  handle cannot arm another retry. Reject an awaited failed-event emission
  with cancellation pending: finalization retains the accepted terminal and
  keeps B dormant, including its original envelope, until later admission.

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

- Run `bun --no-env-file run test:retained-preload` for the guard contracts.
  Use only virtual private roots and hard links, inert original DNS sentinels
  behind an independent network boundary, and real memory SQLite. Exercise
  lexical/canonical aliases, nested/standalone DNS imports and source write
  authority. Do not probe operator data or a real DNS resolver.
- Verify close, strict-close failure, repeated close, disposal and two distinct
  connections requesting the same path. A live connection snapshot must include
  its latest row; a closed connection must retain its pre-close rows. Injected
  capture errors remain fatal and must be distinguished from expected guard
  refusals. A skipped fixture or setup failure is not passing validation.
- Native disposal through a close decorator must retain both the initial row
  and a row written by the decorator before actual close. A no-op replacement
  close must leave the connection live and its later rows visible to capture.

- Run `bun --no-env-file run test:runtime-direct-interrupted` for the direct
  interruption integration suite. Its dedicated runner supplies memory-only
  SQLite, retained identity anchors/snapshots and filesystem/network guards.
  Running the test file without that harness skips it and is not validation.
- Direct `turn.interrupted` without a yield continuation: a bot and a human
  accepted request retained by the real generator can produce a later final
  under the same complete binding. Preserve physical interrupted accounting.
- Keep the existing mutation controls: in-place binding, destination and
  ingress/correlation changes reject retention but still settle the original
  captured interruption. Separately replace the backend object with different
  values, or replace owner, handle, trace, latch or boot witnesses, and require
  no old-owner cancellation. An equal clone may still pass the strict branch.
  Expire a real coordinator lease before an ownership failure is latched and
  require the alias alternative to refuse. A typed initial write failure after
  an alias mutation MUST NOT schedule another persistence attempt.
- Join private media with a queued foreign surface: the real selector refuses
  cross-surface interruption, and complete final text and media remain at the
  original destination before the foreign handoff. Cancellation disposes only
  after an accepted COMMIT; rollback preserves the original collector and
  allocation even after the foreign request completes. Use virtual files and
  memory SQLite; these checks do not prove remote delivery or crash recovery.
- Keep normal final, provider-event-only, started-tool, explicit shutdown and
  replacement-owner controls. Add full-envelope mismatch, successor-only,
  supersession, materialized-output/input-mutation and awaited cancellation
  races. No terminal/manifest/quota reset may make these cases pass.
- Dirty workspace during rebase causes the agent to ask for keep/revert authorization before modifying files.
- Rebase does not silently discard pending messages.
- Rebase preserves actor metadata and source message ids.
- Rebase fails closed when the target message id cannot be matched to a prompt atom.
- Repeated inactivity recovery is bounded and cannot resend the same logical delivery indefinitely.
- After daemon restart, resume MUST pick last-used / snapshot provider when no explicit override is present.
- Stored provider session ids MUST remain when agent or global default differs from last-used.
- Stored provider session ids MUST clear only on an explicit provider change.
- A `/login` or `Not logged in` stub MUST be recorded as `turn.failed` and MUST NOT persist on the session transcript.
