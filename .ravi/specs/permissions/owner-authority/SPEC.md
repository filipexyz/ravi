---
id: permissions/owner-authority
title: "Owner Authority"
kind: capability
domain: permissions
capability: owner-authority
capabilities:
  - provider-runtime
  - agent-identity
  - user-overlay
  - break-glass
  - runtime-context
tags:
  - permissions
  - contacts
  - owner
  - runtime-context
applies_to:
  - src/runtime/runtime-request-context.ts
  - src/bash/hook.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Owner Authority

## Rule

The installation's verified owner acts with their own power, not with the
agent's ceiling. Everyone else acts as the agent ∩ the person.

"The owner" is each contact carrying the global `permission-owner` tag: the
tag is the only gate. The code does not enforce a single owner; writing the
tag is protected (`privileged-contact-writes`, break-glass). Other consumers
(knowledge owner, doctor) assume exactly one.

## Contract

- A turn carries owner authority when its actor is a contact whose identity
  resolved and who carries the installation owner's global `permission-owner`
  tag (never a chat grant), and nothing in that chat narrows them (a chat grant
  with a `deny_*` keeps the user overlay). `permission-admin` and
  `permission-superadmin` are other people's full access: they MUST NOT give
  owner authority, and those turns keep agent ∩ person.
- Such a turn MUST be issued with the contact's own capabilities as its
  bound (the agent identity's positive capabilities are kept alongside); the
  agent's closed ceiling (for example a named list of executables) MUST NOT
  cut it, and neither MUST the agent's own `deny_*` (any of them would drop the
  owner's admin). This drops every agent deny for the owner, including one
  written as an accident guard (for example `deny_execute:executable:rm`): a
  deliberate choice, since the owner holds admin anyway. The owner's own
  `deny_*` stay. The context metadata MUST
  carry `ownerAuthority: contact:<id>`.
- The provider sandbox MUST NOT bound such a turn by the agent profile either:
  the daemon sets `RAVI_TURN_OWNER_AUTHORITY=1` on that turn's env (never on a
  held turn, cleared on the next turn), and Codex opens it unrestricted. A
  bridge turn stays restricted.
- The Bash hook MUST bound an owner-authority turn by its issued snapshot and
  MUST NOT re-apply the agent's live executor ceiling to it. The mark alone
  MUST NOT lend power the snapshot lacks.
- A relay (inform, answer, handoff, thread bootstrap) of such a turn MUST carry
  the same owner authority (the owner's own power, with the target agent's
  positive capabilities alongside), never more, and only when the producing turn
  itself carried `ownerAuthority` for that contact. A relay of a held caller
  (narrowed in the chat, held below break-glass, revoked, or a held relay)
  MUST NOT. A relay produced before the producing turn's chat narrowed the
  owner (a `deny_*` added later) MUST NOT: that chat is re-checked when the
  relay runs.
- A person credential (a paired device key, a call) lends a person's turn,
  never owner authority: another person can speak on it. Its turns keep
  agent ∩ person.
- A chat that narrows the relayed turn's own actor MUST keep its overlay.
- A chat grant, full access included, MUST NOT make anyone an owner.
- The owner's power MUST be re-read on every turn: an untag or
  `permissions deny` takes effect on the next turn. A turn already running
  keeps its issued snapshot until it ends (the Bash hook does not re-read the
  live ceiling for it).
- Any other person's turn is unchanged: agent ∩ person, break-glass withheld.

## Not in scope

Accepted risk (Luís, 26/11: "compartilhar com alguém em um grupo pode ser a
minha escolha"): an owner turn gets an unbounded shell and, on Codex,
full-access in any agent, including agents open to outsiders. Text other
participants wrote in the group enters the owner turn's context, so a
stranger's message can steer what runs with the owner's power (prompt
injection). The core does not mitigate this; the owner chooses where to speak.

The core does not know channels: the rule is the same for WhatsApp, Slack,
or terminal-originated turns. Turns produced with a person credential (voice
today) do not carry owner authority, whatever the channel.
