---
id: permissions/contact-merge-grants
title: "Chat grants across a contact merge"
kind: capability
domain: permissions
capability: contact-merge-grants
tags:
  - permissions
  - contacts
  - merge
applies_to:
  - src/permissions/contact-merge-grants.ts
  - src/permissions/contact-chat-grants.ts
  - src/contacts.ts
  - src/daemon.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Chat grants across a contact merge

Chat-scoped grants (`permission_contact_chat_grants`, ravi.db) are keyed by contact id. A merge deletes the source contact (chat.db). A grant left on the deleted id authorizes no one: no turn resolves to it and no command can name it.

A chat with at least one covering grant is governed by contact grants; a chat with none falls back to the agent identity. Removing the last covering grant therefore changes who governs the chat.

## Rules

- A merge MUST hand the source contact's chat grants to the surviving contact in the same call.
- A grant whose profile carries break-glass power (any `admin:system` capability, or the whole `execute:executable:*`) MUST NOT be carried over. It is removed. That power only comes from an approved `ravi permissions request`.
- Any other grant MUST move to the surviving contact with the same profile and scope. A grant the target already has is kept once.
- A merge or repair MUST NOT remove the last grant covering a scope. That row stays (on a deleted id it authorizes no one) and the outcome is `kept_last_governing_grant`.
- A grant removed or moved off a contact MUST revoke that contact's live runtime contexts that carry it, as `permissions deny` does.
- A self-merge (same id on both sides) MUST move and drop nothing.
- Every grant moved or removed by a merge MUST be recorded as a `permission.grant.merged` contact event on the surviving contact.
- At boot the daemon MUST remove rows left on contacts that no longer exist, keeping the last row covering a scope. The repair MUST NOT move rows to the survivor: it must not add effective permissions (the operator may have revoked the survivor's own grant since).
- The repair MUST be idempotent and MUST NOT touch grants of live contacts.
- Grants live in a different database from contacts, so the hand-off runs after the merge commits. A failure there leaves rows on the deleted id, and the boot repair removes them.
