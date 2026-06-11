---
id: permissions/tag-policy/why
title: "Why Tag-Driven Permission Policy"
kind: why
domain: permissions
capability: tag-policy
---

# Why Tag-Driven Permission Policy

Operators need a manageable way to say "this group can use this tool" or "these
contacts belong to this permission group" without editing dozens of raw REBAC
tuples.

Tags are already the shared classification primitive across agents, sessions,
tasks, contacts, chats, artifacts, and profiles. They are the right selector
language for policy management, but they are not the right authorization
primitive.

## Chosen Design

Use tags as selectors and materialize explicit relations.

This gives operators a small management surface:

```text
tag contact/company/chat -> policy rule -> role membership or delegated grant
```

while keeping the runtime simple:

```text
relations -> capability context -> enforcement
```

## Why Not Check Tags Live In `can()`

Live tag checks inside authorization would create a second hidden permission
engine. Every tool gate, CLI command, app router, provider hook, and future
resource family would have to rediscover which tags mean authority.

That makes important security questions harder:

- Who granted this authority?
- Was it temporary?
- Which exact rule produced it?
- Did revocation remove it?
- Did it survive actor/surface/agent intersection?
- Did an auto-tagging rule accidentally grant it?

Materialization answers those questions with the existing relation graph and
audit path.

## Why Prefer Profiles

Direct tag-to-tool grants are tempting but quickly become unmanageable.

Profiles keep authority named:

```text
policy.profile.trusted-dev -> member role:trusted-dev
role:trusted-dev -> use tool:Bash, execute executable:git, ...
```

Changing the profile changes one place. Tagging or untagging a contact/chat
only changes membership.

Direct materialized grants remain useful for narrow surface exceptions, such as
allowing one chat to delegate one tool.

Profiles are not automatically safe. A tag-managed membership into a powerful
role can grant more authority than a direct emitted tuple. For that reason the
chosen design requires role-closure validation before materializing
policy-managed membership and whenever a managed role changes.

## Rejected Alternatives

- Tags as roles: rejected because tags are many-to-many labels with broad
  classification semantics. Treating every tag as authority would make harmless
  classification dangerous.
- Hard-coded permission groups in agent config: rejected because it splits
  policy from the REBAC graph and makes audit/explain incomplete.
- Manual grants only: rejected because it is precise but too hard to manage at
  scale.
- Auto-tagging creates grants directly: rejected because classifiers and regex
  rules would become authority writers without a separate operator review
  surface.
- Role membership without closure validation: rejected because it bypasses
  direct forbidden-output checks by hiding authority inside `role:<id>`.
- Generic relation upsert for policy grants: rejected because the current
  relation store has one `source` per tuple and the generic upsert overwrites
  provenance/lifetime on conflict.
