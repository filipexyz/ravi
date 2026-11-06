# Slack Threads Checks

## Regression Scenarios

- [ ] Root Slack message with `route.session` MUST still route to the forced parent session.
- [ ] Thread Slack message with `route.session` MUST route to `<parent_session_key>:thread:<thread_ts>`.
- [ ] Thread Slack message without existing forced parent MUST still route to a session key containing `:thread:<thread_ts>`.
- [ ] Prompt `source.threadId` MUST equal the inbound Slack `thread_ts`.
- [ ] Canonical chat MUST use platform id `<channel_id>#<thread_ts>` and `chatType=thread`.
- [ ] Child session output target MUST resolve back to the same Slack thread.
- [ ] Direct inbound actor metadata MUST be preserved on `source`, `context`,
      stored message and participant rows. Agent-produced handoffs MUST keep
      agent provenance while independently verifying their Console actor.
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
- `src/channels/slack/thread-delegated-actor.test.ts` MUST feed captured real
  lifecycle publications through queue/runtime context creation and
  `resolveAccessActor`, with isolated state and transport mocks. It MUST
  cover initial bootstrap for a contact and operator, root delivery after
  parent rotation, a new thread-send caller, queued send and reopen after
  rotation, and genuinely agent/unknown/missing-context initiators.
- The admitted person MUST match both preflight and actor header while the
  runtime actor and provenance remain the producing agent. No later human
  message, requester display name or installation login may supply identity.
- Real report/close-return publications and a subsequent parent continuation
  MUST retain the verified chain; retrying a pending return MUST retain its
  saved closing context and admission time. See
  `src/access/delegated-actor.test.ts` for chain-level negative controls and
  `src/channels/slack/thread-delegated-actor.test.ts` for producer integration.
- Explicit revoke, used-grant removal, profile reduction and contact
  ineligibility/opt-out MUST defeat a queued handoff, including after caller
  rotation. Source/emitter/target mismatch, malformed admission and actor
  hints without verified lineage MUST fail closed.
- `src/cli/commands/sessions.test.ts` and `src/cli/remote-gateway.test.ts` MUST reject an inherited Pi/Codex model mismatch before side effects and preserve an actionable remote error.

## Orphan close

- `bun test src/channels/slack/thread-lifecycle.test.ts` closes a pruned child by its durable request id without recreating the session, is idempotent, and closes only the selected request when child keys collide.
- `bun test src/cli/commands/sessions.test.ts` cloaks missing, ambiguous and unauthorized orphan references as SESSION_NOT_FOUND and requires modify authority before exposing or closing the card.

- [ ] `bun test src/channels/slack/thread-lifecycle.test.ts` refuses close for active triggers addressed by name/key and after pruning; handoff permits closure without prior side effects.
- [ ] Inactive activation verdicts and unrelated reply sessions do not block close.
- [ ] `bun test src/cli/commands/sessions.test.ts src/cli/remote-gateway.test.ts` preserves the refusal code, ids and repoint guidance across CLI/gateway.
- [ ] `bun test src/triggers/__tests__/runner-named-session.test.ts` reloads the repointed trigger, closes the child, and delivers a CI event to the parent with the root source and incremented fire count.
