---
id: permissions/break-glass
title: Break-Glass Power
kind: capability
domain: permissions
capability: break-glass
capabilities:
  - guard
  - approval
tags:
  - break-glass
  - full-access
  - authority
  - channel-free
applies_to:
  - src/permissions/break-glass.ts
  - src/permissions/privileged-contact-writes.ts
  - src/cli/commands/permissions.ts
  - src/cli/commands/tags.ts
  - src/cli/commands/contacts.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Break-Glass Power

## Intent

Break-glass power is authority over the whole system. A write that would confer it
is judged by the power it confers, never by the name of the profile or tag that
carries it.

## Definition

- Break-glass capabilities are `admin:system:*` (any `admin` on `system`) and
  `execute:executable:*` (the full wildcard only). The runtime already treats
  `execute:executable:*` as equal to admin for shell jobs and provider settings.
- `permission-admin`, `permission-owner` and `permission-superadmin` confer
  `admin:system:*` by name, with no definition.
- `full-access` is the built-in profile that carries both.
- A narrow executable grant (`execute:executable:git*`, `execute:executable:curl`)
  is not break-glass.

## Rules

- `ravi permissions allow --apply` (and `ravi permissions resolve --apply`, which
  uses the same plan) MUST refuse, before any write, every profile whose effective
  capabilities include break-glass, or that is an admin profile by name, for every
  caller: agent turn, Console and the local operator terminal alike. The refusal
  is `FULL_ACCESS_APPROVAL_REQUIRED`, exit 3, and points to
  `ravi permissions request full-access`.
- The effective capabilities are the built-in profile's, the stored definition's
  and the explicit `--capabilities`, merged: a stored profile that already carries
  break-glass is refused too. A profile whose runtime ceiling drops capabilities
  (`chat-only`) is judged on what it actually confers.
- A contact gets break-glass power only through an approved
  `ravi permissions request full-access` (operator approval, identity from the
  verified sender of the channel).
- An agent turn or a Console invocation MUST NOT confer break-glass power by
  tagging (`contacts tag`, `contacts set tags`, `tags attach`), in any spelling of
  the slug, even when it holds `admin:system:*` itself. Removing such a tag is
  not refused by this rule.
- The local operator terminal keeps one bootstrap path: tagging a contact
  `permission-owner|admin|superadmin`, so a fresh install can have an owner.
- No caller may create or change a permission profile definition (kind `system`,
  source `permissions`) so that it carries break-glass capabilities
  (`tags create`, `tags set`). Admin profiles need no definition and
  `full-access` is built in.
- Grants that already exist are not revoked by this rule; it blocks new grants.
- The guard is core: it MUST NOT name any channel.

## Out of scope

- `ravi agents permissions <agent> full-access` raises an agent's own ceiling.
  It is the operator's way to make an agent full-access and is governed by the
  agent rules, not this one.
- A caller that already runs arbitrary host commands (`execute:executable:*`)
  can write the database directly. This rule governs the command surface; it
  does not make a full-access agent less than root.
