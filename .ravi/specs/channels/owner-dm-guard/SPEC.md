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
  - src/channels/slack/socket-mode.ts
  - src/omni/consumer.ts
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
- An inbound DM is guarded when, after route matching and any subscription
  reroute, it would land in a session whose key parses as `dmScope: "main"`.
- A guarded DM is admitted only when the sender's resolved contact is an owner.
  An unresolved sender is never the owner.
- The guard yields to a destination the operator chose for that conversation:
  a route whose pattern names the peer (not `*`), or a chat attached to the
  session by a person or an agent. Routing's own bookkeeping attach
  (`attachedByType: system`) is not a choice and does not exempt the DM.
- A blocked DM is held for owner review, the same path a `pairing` DM takes: no
  session row is committed, no runtime turn runs, the sender is recorded as an
  account-pending contact and the owner review event fires once. The owner
  admits the person by adding an explicit route for them (for example a bridge
  agent) or by attaching the chat explicitly. It holds whatever the instance
  `dmPolicy` is, `open` included.
- Decision (19/11/2026): hold for review, not a per-contact session. A session
  of the same agent would still run with that agent's instructions and, in an
  ungoverned chat, its ceiling; holding keeps a stranger out of both.
- No owner tagged: the guard does not block (a fresh installation has nobody
  to protect the session for and nobody to review a held message). Doctor
  SHOULD report an installation whose shared session is reachable by DM with no
  owner tagged.
- Owner set unreadable: fail closed, the DM is held.
- The omni path records the rejection as `route.rejected` with reason
  `dm_owner_session_non_owner`.

## Out of scope

- The authority of a contact in a per-peer session of a high-ceiling agent
  (ungoverned chat inherits the agent identity). That is
  `permissions/agent-identity`; routing a colleague to a dedicated low-ceiling
  agent is the supported way to let them in.
