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
  - src/cli/commands/agents.ts
  - src/cli/commands/instances.ts
  - src/library/agent-definitions.ts
  - src/tags/tag-db.ts
  - src/contacts.ts
  - src/permissions/contact-chat-grants.ts
  - src/permissions/apply-grant.ts
  - src/router/router-db.ts
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
- An agent turn or a Console invocation MUST NOT make an identity resolve to a
  contact holding break-glass power, nor activate such a contact: `contacts
  link`, `contacts merge` (either side), `contacts set <contact> email`,
  `contacts allow`, `contacts approve`, `contacts add` of an existing contact and
  `contacts set <contact> opt-out false` are refused when the contact holds
  break-glass by an admin tag, a break-glass permission tag or a break-glass chat
  grant, dormant or not. Holding admin does not lift this.
- An agent turn or a Console invocation MUST NOT raise another agent to
  break-glass through any writer of agent runtime permissions:
  `ravi agents permissions <other> full-access` (or explicit `admin:system:*` /
  `execute:executable:*`), `ravi agents set <other> defaults` carrying such a
  `runtimePermissions`, and a Library install or update whose profile is
  `full-access`. The check runs before any write (no half-installed agent). The
  operator terminal does it. One rule, `assertAgentBreakGlassRaiseAllowed` in
  `src/permissions/break-glass.ts`, serves every writer.
- `ravi instances pending approve` of a contact holding break-glass is refused
  like `contacts approve`.
- No caller may create or change a permission profile definition (kind `system`,
  source `permissions`) so that it carries break-glass capabilities
  (`tags create`, `tags set`). Admin profiles need no definition and
  `full-access` is built in.
- Grants that already exist are not revoked by this rule; it blocks new grants.
- The guard is core: it MUST NOT name any channel.

## Sinks (what holds)

Command guards give the good error first; the storage sinks are what hold,
whatever code path writes. From an agent turn or a Console invocation, outside
an operator approval, each sink refuses a new write that confers break-glass:

- `dbUpsertTagBinding` (`src/tags/tag-db.ts`): a new contact tag binding.
- `upsertCanonicalContactPolicy` (`src/contacts.ts`): new tags in
  `contact_policies.tags_json`, and activating a contact that holds
  break-glass (status becomes `allowed` or opt-out is cleared), judged before
  the write on the contact actually written. `createContact` and
  `updateContact` check tags before writing anything else.
- Slugs are judged the way the provider reads them: admin names in any
  spelling, and the definition under the normalized slug
  (`permission.legacy.root` is `permission-legacy-root`).
- Agent configs are judged two ways. Effective: a stored `chat-only` config
  confers nothing, so it never counts as already holding break-glass. Stored:
  break-glass written even dormant (`chat-only` with `admin:system:*`) counts,
  because a later profile change wakes it. From an agent turn, a write is
  refused when break-glass becomes effective (a raise, or a dormant one woken)
  or when new break-glass is stored; adjusting an agent that already stores the
  same dormant break-glass is not refused. Invariant: nothing an agent writes
  carries break-glass, not even dormant.
- `dbEnsureContactChatGrant` (`src/permissions/contact-chat-grants.ts`): a new
  contact chat grant.
- `dbUpdateAgent` (`src/router/router-db.ts`): agent defaults that raise
  another agent to break-glass (either stored form of `runtimePermissions`).

The approved paths (`applyPermissionGrant`, used by an approved
`permissions request` and by the denial approval card) run inside
`runApprovedBreakGlassGrant`, the only thing that opens the sinks for an agent
turn. The operator terminal is not refused (owner bootstrap).

- Instance default tags never carry permission tags: `instances set
  defaultContactTags` refuses them from any caller, and the inbound intake
  drops them on read, so a new sender never arrives with power.

## Out of scope

- A second approved path exists besides `permissions request`: the approval card
  of a denial (`src/approval/service.ts`, `applyGrantForDecision`) grants the
  denied capability or full access on an approver's click. It is an approval,
  not a bypass; who may click is governed by the approval rules.
- The terminal is recognized by the absence of an agent identity in the process
  (`getScopeContext().agentId`, which falls back to `RAVI_AGENT_ID`). For an
  agent's Bash this holds because the Bash hook refuses unsetting `RAVI_*`.
- An agent raising its OWN ceiling is not refused by this rule (review N5; it
  needs `agents` mutate authority). Follow-up.
- Break-glass is a fixed list (`admin:system:*`, `execute:executable:*`); a new
  total wildcard must be added to it.
- A caller that already runs arbitrary host commands (`execute:executable:*`)
  can write the database directly. This rule governs the command surface; it
  does not make a full-access agent less than root.
