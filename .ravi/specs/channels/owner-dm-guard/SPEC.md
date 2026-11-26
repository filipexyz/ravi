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
  - src/link/connector-turn.ts
  - src/pages/read.ts
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

Because no one else's direct message can land there, the shared session can be
the owner's own direct session: the owner's verified DM in it counts as the
operator's turn (private Pages, Knowledge, the owner's connected accounts) while
nothing else writes in it either.

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
- No route or attached chat admits anyone else into the shared session: a
  literal or glob route, with or without a forced session, and a chat attached
  by routing, a person or an agent all leave a non-owner's DM held.
- To let a person talk to an agent, the owner gives them a session of their
  own: a route whose pattern is their literal id with `--dm-scope per-peer`
  (`--session <name>` can name that session), or an agent whose `dmScope` is
  not `main`. A forced session name alone does not isolate a person on an
  agent whose DMs share one session: until that session exists, the commit
  lands in the shared key and names it after the route, so the DM stays held.
  Approving the held contact (`ravi instances pending approve`) allows the
  contact but creates no route, so the DM stays held until a route gives the
  person a session of their own.
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
- Decision (26/11/2026): the shared session admits owners only. The 19/11
  exception for a route naming the person, or a chat attached by a person or
  an agent, is gone: with it the session could never be the owner's alone, and
  the owner's own DM never counted as the operator's turn.
- No owner tagged: the guard does not block (a fresh installation has nobody
  to protect the session for and nobody to review a held message). This is
  fail-open and nothing reports it yet: an installation is protected only once
  its owner contact is tagged.
- Owner set unreadable: fail closed, the DM is held.
- The omni path records the rejection as `route.rejected` with reason
  `dm_owner_session_non_owner`.

## The owner's own direct session

- The owner's DM in an agent's shared session (`agent:<id>:main` exactly, not a
  thread under it) runs in a session of their own
  (`readIsPrivateDirectSession` → `isSharedDmSessionPrivateToOwner`) when:
  - the speaker is the one contact tagged `permission-owner`. With two tagged
    owners both land there; with none, the guard admits everyone;
  - every active route that sends chats into the session by name
    (`routes.session_name`, compared trimmed, as the router looks it up)
    reaches one direct peer: a literal id, never a glob (it also matches
    `group:` targets), a `group:` or a `thread:` pattern. This guard covers
    direct messages only;
  - every chat attached to the session is the speaker's own direct chat or a
    thread inside it (`dbGetThreadParentChat`). An attached chat can also
    receive the session's answers.
- Anything unreadable is not private. A relay, a cron or a thread child of the
  shared session keeps the rules of `knowledge` and `cli/connectors`.
- The rule is channel-free: it reads contacts, routes and chat subscriptions,
  never a channel name.

## Out of scope

- The authority of a contact in a per-peer session of a high-ceiling agent
  (ungoverned chat inherits the agent identity). That is
  `permissions/agent-identity`; routing a colleague to a dedicated low-ceiling
  agent is the supported way to let them in.
