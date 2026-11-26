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

## Contract

- A turn carries owner authority when its actor is a contact whose identity
  resolved and who carries the installation owner's global `permission-owner`
  tag (never a chat grant), and nothing in that chat narrows them (a chat grant
  with a `deny_*` keeps the user overlay). `permission-admin` and
  `permission-superadmin` are other people's full access: they MUST NOT give
  owner authority, and those turns keep agent ∩ person.
- Such a turn MUST be issued with the contact's own capabilities as its
  bound (the agent identity's capabilities are kept alongside); the agent's
  closed ceiling (for example a named list of executables) MUST NOT cut it.
  The context metadata MUST carry `ownerAuthority: contact:<id>`.
- The Bash hook MUST bound an owner-authority turn by its issued snapshot and
  MUST NOT re-apply the agent's live executor ceiling to it. The mark alone
  MUST NOT lend power the snapshot lacks.
- A relay (inform, answer, handoff, thread bootstrap) of such a turn MUST carry
  the same owner authority, never more. A relay of a held caller (narrowed in
  the chat, held below break-glass, revoked, or a held relay) MUST NOT.
- A chat grant, full access included, MUST NOT make anyone an owner.
- The owner's power MUST be re-read on every turn: an untag or
  `permissions deny` takes effect on the next turn.
- Any other person's turn is unchanged: agent ∩ person, break-glass withheld.

## Not in scope

The core does not know channels: the rule is the same for WhatsApp, Slack,
voice or terminal-originated turns.
