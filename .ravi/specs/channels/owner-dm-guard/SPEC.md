---
id: channels/owner-dm-guard
title: Owner DM Guard
kind: capability
domain: channels
capability: owner-dm-guard
tags:
  - channels
  - slack
  - whatsapp
  - security
  - sessions
applies_to:
  - src/channels/owner-dm-guard.ts
  - src/channels/pending-review-event.ts
  - src/channels/slack/socket-mode.ts
  - src/omni/consumer.ts
  - src/router/resolver.ts
owners:
  - dev
status: active
normative: true
---

# Owner DM Guard

## Intent

A direct message from someone who is not the installation owner never resolves
into the owner's shared session. The owner's shared session is an agent's
`dmScope: "main"` session, `agent:<id>:main`: every DM of that agent collapses
into it, and it carries the owner's history and, in an ungoverned chat, the
agent's whole ceiling (`permissions/agent-identity`).

## Contract

- The owner is any contact tagged `permission-owner` (the same tag Knowledge
  uses for the operator).
- An inbound DM is guarded when it would land in a session whose key parses as
  `dmScope: "main"`, including a thread forked from it. The key is the one the
  commit will produce (`previewCommittedSessionKey`), after route matching and
  any subscription reroute: a route that forces an existing session redirects
  there, and a thread under a forced session forks from it, so
  `matched.sessionKey` alone is not where the message lands.
- A guarded DM is admitted only when the sender's resolved contact is an owner.
  An unresolved sender is never the owner.
- The guard yields to a destination the operator chose for that conversation,
  and each choice vouches only for the destination it names:
  - a route whose pattern is a literal id (no `*`), when the message lands where
    that route sends it. A glob (`*`, `U0*`, `5511*`) is a wildcard: it matches
    people the operator never named. A chat subscription that reroutes the DM
    elsewhere (for example routing's earlier attach of the chat to the shared
    session) takes the DM away from the route, and the route no longer vouches
    for it;
  - a chat attached by a person or an agent, when the message lands in the
    attached session. Routing's own bookkeeping attach (`attachedByType:
    system`) is not a choice and does not exempt the DM.
- Admission is a route. `ravi sessions attach` on a chat that routing already
  attached keeps that attach and its `system` provenance (the attach is
  idempotent), so it does not admit the person; only a subscription a person or
  an agent created counts as an explicit attach. Approving the held contact
  (`ravi instances pending approve`) allows the contact but creates no route,
  so the DM stays held until a route names the person.
- A blocked DM is held for owner review, the same path a `pairing` DM takes: no
  session row is committed, no runtime turn runs, the sender is recorded as an
  account-pending contact and, the first time, `ravi.contacts.pending` fires on
  both paths (omni and Slack). It holds whatever the instance `dmPolicy` is,
  `open` included.
- A reply a cloud run is waiting for (`aprovar <código>`, a message in a thread
  bound to the run) reaches the run before routing, policy and this guard, on
  both paths. A held sender can still answer the run that asked them.
- Decision (19/11/2026): hold for review, not a per-contact session. A session
  of the same agent would still run with that agent's instructions and, in an
  ungoverned chat, its ceiling; holding keeps a stranger out of both.
- No owner tagged: the guard does not block (a fresh installation has nobody
  to protect the session for and nobody to review a held message). This is
  fail-open, and an installation is protected only once its owner contact is
  tagged, so `ravi doctor` reports it (`permissions.owner_contact`, `warn`; see
  `doctor/check-catalog`).
- Owner set unreadable: fail closed, the DM is held.
- The omni path records the rejection as `route.rejected` with reason
  `dm_owner_session_non_owner`.

## Out of scope

- The authority of a contact in a per-peer session of a high-ceiling agent
  (ungoverned chat inherits the agent identity). That is
  `permissions/agent-identity`; routing a colleague to a dedicated low-ceiling
  agent is the supported way to let them in.
