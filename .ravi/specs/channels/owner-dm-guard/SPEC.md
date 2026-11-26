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

The guard keeps the routing only. Whether a turn is the operator's does not
depend on it: the owner's own verified message counts as the operator's turn
wherever it runs, shared session or not, a group included (spec
`cli/connectors`, "The owner's own turn").

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
  An unresolved sender is never the owner, and neither is another app's bot:
  its DM would receive the session's answers, so it is held too.
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
  an agent, is gone: the owner's DM stays in the shared session and every other
  person's DM gets a session of their own or is held.
- Decision (26/11/2026, 15:11Z, owner): "se eu escrevo eu quero que esse dado
  venha, independente de onde estar". The owner's turn no longer depends on
  the session being theirs alone; this guard is not a privacy check.
- No owner tagged: the guard does not block (a fresh installation has nobody
  to protect the session for and nobody to review a held message). This is
  fail-open and nothing reports it yet: an installation is protected only once
  its owner contact is tagged.
- Owner set unreadable: fail closed, the DM is held.
- The omni path records the rejection as `route.rejected` with reason
  `dm_owner_session_non_owner`.

## The owner's turn

- The owner's verified message counts as the operator's turn in the shared
  session, in a per-person session and in a group alike (`cli/connectors`,
  "The owner's own turn"). This guard adds nothing to that rule and reads
  no privacy from routes or attached chats.
- The rule is channel-free: it reads contacts and session keys, never a
  channel name.

## Out of scope

- The authority of a contact in a per-peer session of a high-ceiling agent
  (ungoverned chat inherits the agent identity). That is
  `permissions/agent-identity`; routing a colleague to a dedicated low-ceiling
  agent is the supported way to let them in.
