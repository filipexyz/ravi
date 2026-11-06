# Delegation / CHECKS

## Checks

- Delegation grants MUST be explicit, auditable, and explainable.
- Effective authority for user-initiated execution MUST be bounded by the
  executor agent ceiling and delegated context.
- In ungoverned chats, a resolved person with no independent capability grant
  MUST retain the agent-identity path. In governed chats, contact grants MUST
  only narrow the executor ceiling (`src/runtime/runtime-request-context.test.ts`).
- Unknown or unresolved actors MUST receive no delegated authority.
- Break-glass authority MUST be distinguishable from normal delegated authority
  in traces and provenance.
- `bun test src/permissions/delegation.test.ts src/permissions/capability-context.test.ts`
  SHOULD pass after changing delegation behavior.
- Externally governed authority is scoped to one explicit provider execution
  compartment and never mutates ambient Agent permissions.
- Signed turn grants cannot exceed the locally accepted provider ceiling or
  local host/provider/runtime guards.
- Wrong audience, binding revision, operation digest, expiry, replay identity,
  or signature fails closed.
- Provider-private Role vocabulary never enters the generic runtime contract.

## Console Actor Handoff Regression

- `src/access/delegated-actor.test.ts` MUST check that preflight and actor
  header agree on the verified person, preserve the executor, reject a hint
  without admission, and leave personal connector eligibility unchanged.
- The same suite MUST cover source/target/emitter mismatch, invalid admission
  time, missing/cyclic lineage, forged derived metadata, unresolved or
  ineligible people, and explicit authority withdrawal. Normal completion,
  rotation and expiry after admission MUST preserve already-admitted work.
- Resolved pending/discovered group participants MUST retain attribution
  without gaining capabilities; blocked, missing and opted-out people MUST
  remain refused.
- `src/channels/slack/thread-delegated-actor.test.ts` MUST exercise real
  lifecycle publication through runtime context creation and access actor
  resolution with isolated state and mocked transport: initial bootstrap,
  current caller on thread-send, queueing and reopen after caller rotation,
  real report/close-return producers and legitimate derived CLI credentials.
- Used-grant revocation and opt-out MUST deny both an already-created child
  and one still queued. Revoking one caller's grant MUST NOT revoke an
  unrelated contact or scope (`src/channels/slack/thread-delegated-actor.test.ts`).
- A new human turn MUST NOT replace the person recorded on an already queued
  handoff. An unknown or independent agent turn MUST NOT borrow that person.
