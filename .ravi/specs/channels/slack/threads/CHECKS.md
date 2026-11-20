# Slack Threads Checks

## Regression Scenarios

- [ ] Root Slack message with `route.session` MUST still route to the forced parent session.
- [ ] Thread Slack message with `route.session` MUST route to `<parent_session_key>:thread:<thread_ts>`.
- [ ] Thread Slack message without existing forced parent MUST still route to a session key containing `:thread:<thread_ts>`.
- [ ] Prompt `source.threadId` MUST equal the inbound Slack `thread_ts`.
- [ ] Canonical chat MUST use platform id `<channel_id>#<thread_ts>` and `chatType=thread`.
- [ ] Child session output target MUST resolve back to the same Slack thread.
- [ ] Actor metadata MUST be preserved on `source`, `context`, stored message and participant rows.
- [ ] Runtime continuity MUST fork from parent provider state when the child has no resumable state.
- [ ] Runtime continuity MUST resume child provider state after the child has its own state.
- [ ] `thread.create` MUST be discoverable only on executable Slack surfaces.
- [ ] Programmatic create MUST post one native Slack root through the durable
      runner and use its `ts` as the thread id.
- [ ] Repeated delivery observations MUST reuse the same child and publish no
      duplicate first prompt.
- [ ] An inbound reply racing the programmatic bootstrap MUST preserve the
      initial agent prompt and MUST NOT duplicate the thread-created event.
- [ ] Programmatic thread-created events MUST carry the child `agentId`.
- [ ] `--model` MUST be stored before first-prompt publication.
- [ ] The `create-thread` result MUST parse through its declared return schema:
      `origin` is `null` for a request from Slack or from a group and
      `{ channel, canonicalChatId }` for one from a direct chat on another
      channel. A field the handler returns and the schema omits MUST fail the
      test, not the production call after the thread exists.
- [ ] Creating from an existing thread MUST create a sibling channel-root
      thread, not a nested thread.
- [ ] `thread.close` MUST be available only from a Slack thread child.
- [ ] Silent close MUST emit no parent prompt.
- [ ] Close with `--return` MUST emit exactly one structured parent completion.
- [ ] Repeated close MUST be idempotent.
- [ ] A later inbound Slack reply MUST reuse and reopen the closed child.
- [ ] Reopening MUST preserve and later deliver a pending parent completion.
- [ ] A Slack channel-root or DM session that can run `sessions` MUST get the
      "Slack Threads" section steering off-topic work to `create-thread`.
- [ ] A Slack thread child MUST get the in-thread variant; sentinels, non-Slack
      channels and contexts without `sessions` MUST NOT get the section.
- [ ] `thread.report` MUST reach the parent at the channel root, named by title
      and child session, and leave the thread open.
- [ ] A close return MUST carry the same title, child session and link.
- [ ] `thread.list` MUST list the parent's threads from the root or a child,
      hiding closed ones unless `--all`.
- [ ] `thread.send` MUST publish one in-thread Execute turn, reopen a closed
      thread, and refuse thread callers, unknown threads and unstarted threads.
- [ ] `thread-send` MUST publish `after_response` with source `default` unless
      the caller passes `--steer`, `--immediate` or `--barrier`; against a thread
      whose turn is generating or running a tool it MUST NOT interrupt the turn
      and MUST release the instruction only once the turn ends, while `--steer`
      and `--immediate` still take the turn; conflicting or unknown barriers MUST
      yield `USAGE_ERROR` without publishing
      (`src/channels/slack/thread-lifecycle.test.ts`, `src/cli/commands/sessions.test.ts`,
      `src/runtime/session-dispatcher.test.ts`).
- [ ] A `thread-send` instruction queued behind a thread's turn MUST reopen the
      thread when it is delivered after the thread closed itself in that turn: the
      next close MUST be `changed: true`, deliver its `--return` to the parent and
      mark the card reopened; a report, another child's instruction and an open
      record MUST NOT change the lifecycle; a failing card update MUST NOT stop
      the delivery. The real turn start MUST make the call
      (`src/runtime/session-dispatcher.test.ts` with the real thread record and
      `closeSlackThread`, `src/channels/slack/thread-lifecycle.test.ts`,
      `src/runtime/runtime-request-builder.trigger-owner.test.ts`).
- [ ] The channel-root variant MUST route follow-ups on an existing thread's
      subject to that thread and relay between threads; the thread variant MUST
      ask for relays through `thread.report`.
- [ ] `report`, `close-thread` and `thread-send` refusals MUST carry a typed
      `THREAD_*` code (`THREAD_IDENTITY_MISMATCH` for a session holding an open
      thread's name under another key), and the remote relay MUST show local
      copy for them instead of "Remote command failed."
      (`src/cli/commands/sessions.test.ts`, `src/cli/remote-gateway.test.ts`).
- [ ] Empty and whitespace-only `report`/`thread-send` messages, including
      literal `\n` decoded to an empty message, MUST yield `USAGE_ERROR`, exit
      `2`, without publishing or changing lifecycle state
      (`src/cli/commands/sessions.test.ts`, `src/channels/slack/thread-lifecycle.test.ts`).
- [ ] `thread-configure`, `close-thread`, `report`, and `thread-send` MUST pass
      the original throwable and nested cause to the shared CLI boundary.
      Verify `UNHANDLED_ERROR`, `SQLITE_CAPACITY`, and unchanged typed refusal
      codes, exit codes, and suggested actions (`src/cli/commands/sessions.test.ts`).
- [ ] `thread.list` MUST mark an open thread whose child session is gone with
      `childSessionMissing: true`, and `thread-send` to it MUST fail with
      `THREAD_SESSION_MISSING` (`src/channels/slack/thread-lifecycle.test.ts`).
- [ ] A PR follow armed by an open thread MUST address the child and its thread,
      and the trigger runner MUST deliver its turn with the thread's chat, canonical
      chat id and timestamp (a trigger without a thread id in its reply source keeps
      the session's last chat); closing that thread MUST hand every `gh-follow:*`
      trigger it receives to the durable parent in the same transaction as the close
      (and publish `ravi.triggers.refresh`); a close refused by a pending decision or
      by another active trigger MUST leave the follows with the thread, with no
      refresh published and no intent saved; a refresh event that fails MUST leave
      the intent set so `gh-follow` maintenance publishes it again, once, until it
      succeeds; a closed thread MUST resolve to the parent
      The follow's instruction MUST tell a thread that another session started to
      report CI, merge or review news to that session with `ravi sessions report`
      (`src/hooks/gh-watch.test.ts`, `src/pr/service.test.ts`,
      `src/triggers/__tests__/runner-named-session.test.ts`,
      `src/channels/slack/thread-lifecycle.test.ts`).
- [ ] A session rename MUST refuse a name an open thread saves for another
      child session, even when that child is gone
      (`src/router/thread-identity.test.ts`).

## Commands

```bash
bun test src/channels/slack/socket-mode.test.ts src/channels/slack/thread-lifecycle.test.ts src/runtime/runtime-session-continuity.test.ts
bun test src/prompt-builder.test.ts src/runtime/runtime-system-prompt.test.ts src/cli/commands/sessions.test.ts
bun run typecheck
bun run build
```

- `bun test src/decisions/decisions.test.ts src/channels/slack/thread-card.test.ts` MUST verify pending close refusal, one admission, sibling isolation, retry and pending-card fallback.

- `src/channels/slack/thread-lifecycle.test.ts` MUST classify human-requested bootstraps as interactive while keeping agent/cron/observer bootstraps background and actor authority unchanged.
- `src/cli/commands/sessions.test.ts` and `src/cli/remote-gateway.test.ts` MUST reject an inherited Pi/Codex model mismatch before side effects and preserve an actionable remote error.

## Orphan close

- `bun test src/channels/slack/thread-lifecycle.test.ts` closes a pruned child by its durable request id without recreating the session, is idempotent, and closes only the selected request when child keys collide.
- `bun test src/cli/commands/sessions.test.ts` cloaks missing, ambiguous and unauthorized orphan references as SESSION_NOT_FOUND and requires modify authority before exposing or closing the card.

## Turn attention

- Runtime dispatcher/intake tests MUST reject missing/replaced attention executors, bypass a live parent's debounce, recheck the pinned parent after asynchronous preflight and during cold launch, and refuse a live/starting runtime bound to another canonical key even when name, agent and provider match.

- `bun test --preload ./src/test/isolated-runtime-preload.ts src/channels/slack/thread-attention-admission.test.ts` terminates a real publisher process after fake-broker acceptance and before its publication receipt, both before and after consumer admission. After advancing beyond the simulated two-minute broker dedup window and publication lease, a fresh process MUST admit one logical notice without loss. A restart at 90 seconds (after the 60-second stream TTL but inside dedup) followed by 121 seconds MUST also deliver once. Retry envelope/authority MUST stay identical across a reason change; late copies after a later physical turn MUST remain fenced.
- The same admission suite MUST cover concurrent consumers, database reopen, typed capacity refusal, uncertain/accepting outcomes, unknown receipts, divergent target/authority/turn/source and injected execution metadata. Uncertain work MUST never call the runtime again.
- `bun test --preload ./src/test/isolated-runtime-preload.ts src/runtime/turn-progress.test.ts` MUST run owner and reconciler in separate processes over shared isolated state: recent provider activity prevents false `no_signal`; heartbeat alone and legitimate silence do not. Replaced attempt/boot/turn, recovery claims and lease expiry during the write MUST fence stale progress. Sampling MUST not report silence prematurely.
- `bun test src/channels/slack/thread-turn-health.test.ts src/channels/slack/thread-lifecycle.test.ts` covers missing terminals, partial output before a tool, long legitimate tools/provider activity, expired ownership leases, human interruption, intentional silence, completed turns without final return, channel-only replies, and close during a tool.
- Two ticks across a database reopen, concurrent ticks, and `no_signal` becoming `owner_lost` MUST publish one notice per turn. Publication failure MUST retry with the same message id; a new turn may produce a new notice.
- Failed transport and missing-authority cases MUST not retry before five minutes, including after database reopen and a same-turn reason change. Retry at the boundary MUST preserve the frozen message id/envelope. A new physical turn MUST be eligible immediately, and a late failure from the old claim MUST not delay the new turn. Successful publication MUST clear the failure delay while preserving pending-admission reconciliation.
- Reopening a pre-delay schema MUST add the retry column without losing existing health or notification receipts; repeated initialization MUST be idempotent.
- An attention notice from a restricted child MUST preserve its exact caller context and keep the parent narrowed after ordinary context rotation. Missing, ambiguous, wrong-session, wrong-agent or wrong-kind authority MUST publish nothing and leave attention visible.
- Listing MUST return the stored observation unchanged until reconciliation; the strict CLI return schema MUST accept old summaries and preserve the new additive `turnHealth`.
- The runtime provider-activity test MUST prove that real activity updates the matching canonical turn's signal without emitting a public activity event.
- A completed automatic media-only reply with a frozen final manifest MUST remain `idle` after the delivery grace. Media in commentary, errors, failed delivery or an unfinished turn MUST NOT satisfy final-reply evidence.
- `src/runtime/session-trace.test.ts` MUST preserve a successor's live signal when an old provider emits activity after ownership changes, while retaining the current-owner control.

## Durable subscribers at close

- [ ] `bun test src/channels/slack/thread-lifecycle.test.ts` refuses close for active triggers addressed by name/key and after pruning; handoff permits closure without prior side effects.
- [ ] `bun test src/triggers/page-comment-owner.test.ts` arms a follow from a thread on the durable parent with the parent's chat and no thread id, fails closed when a Slack thread child's lifecycle or parent is missing (for a page comment follow only then: another channel's thread or a task's thread keeps its own follow, while the default rule used by the PR follow still refuses them), and lets a thread whose only triggers were `page-comment:*` close after the boot repair, run through the daemon's own boot step; a non-`page-comment:*` trigger on the child still blocks close.
- [ ] Inactive activation verdicts and unrelated reply sessions do not block close.
- [ ] `bun test src/cli/commands/sessions.test.ts src/cli/remote-gateway.test.ts` preserves the refusal code, ids and repoint guidance across CLI/gateway.
- [ ] `bun test src/triggers/__tests__/runner-named-session.test.ts` reloads the repointed trigger, closes the child, and delivers a CI event to the parent with the root source and incremented fire count.

## Parent runtime configuration

- Pause a real host event loop on a fake active provider, clear provider/model
  through the parent, then complete that turn. Verify fresh next-turn selection
  and native continuity, with no interrupt/restart and intact output/usage.

- A parent attached to Slack from another channel MUST configure its owned Slack
  thread using persisted lifecycle identity; a historical channel is not a deny.
- A denied provider change MUST preserve its permission-denial audit while
  leaving runtime fields untouched. A changed authorization snapshot MUST refuse
  configuration before any runtime write.

- An authorized root parent configures only its persisted child with
  `sessions thread-configure`; the old generic `set-effort` still requires its
  original scope. Verify real persisted readback and next-turn application.
- Cover child name/key/request id/thread timestamp, another parent, sibling
  caller, missing child, agent mismatch, and explicit unauthorized `--session`.
- Cover atomic provider/model updates, invalid provider/model/effort/thinking,
  empty patches, provider authority, `clear`, no-op, and closed-thread behavior.
- The real registry and generated request schemas MUST reject thread-only and
  thread-plus-session inputs, accept each runtime option individually and
  several together, and preserve omitted overrides. Thinking MUST accept
  `off|normal|verbose|clear` with case/whitespace variants and reject unknown,
  empty, whitespace-only, null, and non-string values. Generated SDK signatures
  MUST retain the thread and option fields and require the options bag. The
  TypeScript union enforces at least one field; Swift/Dart constructors still
  allow an explicit empty bag, so server validation remains required there.
- Failed validation/authorization leaves all fields unchanged; successful
  configuration leaves history/subscriptions/status intact and publishes nothing.
- Generic reset/delete/rename/read remain unauthorized without their own grant.
- Run the focused thread runtime and sessions command suites in separate
  disposable-state processes, plus scope and gateway authorization regressions.

- `src/runtime/thread-provider-config.test.ts` MUST cover clear before capacity
  failure, clear during backoff, ownership replacement before failure/during wait,
  and clear before/after a retry snapshot. Verify isolated retry input, preserved
  retry budget, once-only authority release, no native-state resurrection, and
  successor delivery on the newly configured provider.

- `src/channels/slack/thread-lifecycle.test.ts` checks a human initiating context survives durable root delivery into the bootstrap runtime actor, with agent producer provenance retained and Bases attribution restored.
