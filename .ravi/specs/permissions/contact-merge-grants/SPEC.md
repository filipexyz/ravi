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

Chat-scoped grants (`permission_contact_chat_grants`, ravi.db) are keyed by contact id. A merge deletes the source contact (chat.db). A grant left on the deleted id is dead: no turn resolves to it and no command can name it.

## Rules

- A merge MUST hand the source contact's chat grants to the surviving contact in the same call.
- A grant whose profile carries break-glass power (any `admin:system` capability, or the whole `execute:executable:*`) MUST NOT be carried over. It is removed. That power only comes from an approved `ravi permissions request`.
- Any other grant MUST move to the surviving contact with the same profile and scope. A grant the target already has is kept once.
- Every grant moved or removed by a merge MUST be recorded as a `permission.grant.merged` contact event on the surviving contact.
- At boot the daemon MUST repair grants left on contacts that no longer exist: follow the `contact_merge` link events to the surviving contact and apply the same rules. A grant whose contact was never merged anywhere is removed.
- The repair MUST be idempotent and MUST NOT touch grants of live contacts.
- Grants live in a different database from contacts, so the hand-off runs after the merge commits. A failure there leaves grants on the deleted id, and the boot repair finishes the job.
