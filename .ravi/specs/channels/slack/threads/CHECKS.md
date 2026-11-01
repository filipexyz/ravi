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
- [ ] `report`, `close-thread` and `thread-send` refusals MUST carry a typed
      `THREAD_*` code (`THREAD_IDENTITY_MISMATCH` for a session holding an open
      thread's name under another key), and the remote relay MUST show local
      copy for them instead of "Remote command failed."
      (`src/cli/commands/sessions.test.ts`, `src/cli/remote-gateway.test.ts`).
- [ ] `thread.list` MUST mark an open thread whose child session is gone with
      `childSessionMissing: true`, and `thread-send` to it MUST fail with
      `THREAD_SESSION_MISSING` (`src/channels/slack/thread-lifecycle.test.ts`).
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

- `bun test src/channels/slack/thread-turn-health.test.ts src/channels/slack/thread-lifecycle.test.ts` covers missing terminals, partial output before a tool, long legitimate tools/provider activity, expired ownership leases, human interruption, intentional silence, completed turns without final return, channel-only replies, and close during a tool.
- Two ticks across a database reopen, concurrent ticks, and `no_signal` becoming `owner_lost` MUST publish one notice per turn. Publication failure MUST retry with the same message id; a new turn may produce a new notice.
- Listing MUST return the stored observation unchanged until reconciliation; the strict CLI return schema MUST accept old summaries and preserve the new additive `turnHealth`.
- The runtime provider-activity test MUST prove that real activity updates the matching canonical turn's signal without emitting a public activity event.
