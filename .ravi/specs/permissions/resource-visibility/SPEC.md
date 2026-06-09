---
id: permissions/resource-visibility
title: "Resource Visibility"
kind: capability
domain: permissions
capability: resource-visibility
capabilities:
  - rebac
  - least-privilege
  - discovery
  - enumeration-resistance
tags:
  - permissions
  - visibility
  - discovery
  - apps
  - agents
  - sessions
  - contacts
applies_to:
  - src/permissions/scope.ts
  - src/cli/commands/apps.ts
  - src/cli/commands/agents.ts
  - src/cli/commands/sessions.ts
  - src/cli/commands/contacts.ts
  - src/cli/commands/crm.ts
owners:
  - ravi-rebac
  - ravi-dev
status: active
normative: true
---

# Resource Visibility

## Intent

Resource visibility defines what a principal can discover before it tries to
operate on a Ravi object.

Ravi MUST treat discovery as disclosure. Listing, showing, checking,
autocomplete, alias resolution, and picker APIs can reveal operational state,
installed capabilities, relationships, people, sessions, agents, and apps.
Those surfaces MUST be authorized with the same care as execution.

## Invariants

- If a runtime context has an `agentId`, discovery MUST fail closed or filter
  to the resources visible to that effective context.
- Direct local CLI execution with no resolved principal MAY remain an operator
  break-glass path and MAY see all local resources.
- A list/search command MUST filter unauthorized resources out of the result.
- A direct `show/get/info/check` command for an unauthorized existing resource
  SHOULD return the same external shape as a missing resource.
- Operation attempts MAY return a permission-denied error, but that error MUST
  NOT include sensitive metadata from the unauthorized resource.
- Autocomplete, dynamic command aliases, app registries, SDK discovery, UI
  pickers, and machine-readable manifests MUST obey the same visibility rules
  as CLI list/show.
- A manifest, route, session key, display name, contact handle, chat title, or
  raw provider id is not an authorization grant.
- `open` CLI scope MUST NOT bypass resource visibility under runtime context.

## Canonical Visibility Relations

These are the current resource visibility boundaries:

```text
agent:<viewer> view agent:<target-agent>
agent:<viewer> access session:<target-session>
agent:<viewer> modify session:<target-session>
agent:<viewer> use app:<app-id>
agent:<viewer> read_contact contact:<contact-id>
agent:<viewer> read_own_contacts system:*
agent:<viewer> read_tagged_contacts system:<tag>
agent:<viewer> write_contacts system:*
```

Rules:

- An agent MAY always see itself.
- A session owner MAY always access and modify its own current session.
- `modify session:<id>` is write authority and MUST NOT be required for plain
  session visibility when `access session:<id>` is enough.
- `use app:<id>` is the app discovery and non-mutating operation grant.
- `execute app:<id>` authorizes mutating app dispatch, but it MUST NOT by
  itself make an app appear in broad discovery surfaces. Operators SHOULD grant
  both `use` and `execute` when a principal should discover and mutate an app.
- `write_contacts system:*` implies contact read visibility because contact
  mutation cannot be safely performed without reading the target.
- Contact policy status (`allowed`, `pending`, `blocked`, `discovered`) is not
  visibility permission by itself.

## Enumeration Resistance

For lookup-style commands:

- Unauthorized agents SHOULD appear as missing agents.
- Unauthorized sessions SHOULD appear as missing sessions.
- Unauthorized apps SHOULD appear as missing apps or disabled aliases.
- Unauthorized contacts SHOULD appear as missing contacts.
- Unauthorized CRM entities SHOULD appear as missing when no visible backing
  contact/account/opportunity can be reached.

Audit ledgers MAY record the real denial internally, but user/runtime output
MUST NOT help an untrusted principal enumerate ids.

## Resource Families

### Agents

Agent discovery MUST be backed by `canViewAgent` or an equivalent check.

- `agents list` MUST only return visible agents.
- `agents show <id>` MUST require self-view or `view agent:<id>`.
- Agent sync, picker, and route selection surfaces MUST NOT disclose hidden
  agents.

### Sessions

Session discovery MUST be backed by `canAccessSession` and
`canModifySession`.

- `sessions list/info/read/trace` MUST require own-session access or
  `access session:<id>`.
- `sessions reset/delete/rename/attach/detach/mute/unmute` MUST require
  own-session authority or `modify session:<id>`, unless a narrower operation
  relation is introduced.
- Session traces are sensitive and MUST NOT be visible merely because the agent
  can receive messages in the same chat.

### Apps

App discovery MUST be backed by `use app:<id>`.

- `apps list` MUST filter manifests by app visibility.
- `apps show <id>` and router builtin `show/help/check` MUST require
  `use app:<id>` under runtime context.
- Root dynamic app aliases MUST only resolve for visible apps.
- Invalid hidden apps MUST NOT leak their manifest path or validation errors to
  unauthorized principals.

### Contacts

Contact discovery MUST be backed by `canAccessContact` or an equivalent
context-aware check.

- `contacts list/find/info/check/profile/timeline` MUST filter or deny through
  contact visibility.
- Pending/discovered contact queues MUST be admin-only or filtered to the
  current principal's visible contact set.
- Raw phone, LID, JID, platform user id, email, or display name search MUST NOT
  bypass canonical contact visibility.

### CRM

CRM discovery MUST be contact-backed until explicit CRM object grants exist.

- Any CRM entity read that references a contact MUST require visibility into at
  least one backing contact.
- CRM account/opportunity/task/activity/fact reads with no visible backing
  contact MUST fail closed.
- Future CRM-specific grants MAY add narrower objects such as
  `crm_account:<id>`, `crm_opportunity:<id>`, or `crm_task:<id>`, but they MUST
  not bypass contact privacy accidentally.

## Acceptance Criteria

- A non-granted runtime agent does not see hidden apps in `apps list`,
  `apps show`, root aliases, SDK discovery, or UI registries.
- A non-granted runtime agent does not see other agents in `agents list/show`.
- A non-granted runtime agent does not see other sessions in
  `sessions list/info/read/trace`.
- A non-granted runtime agent does not see contacts through
  `contacts list/find/info/check/profile/timeline`.
- A non-granted runtime agent does not recover hidden contacts through CRM read
  commands.
- Direct local CLI execution without a principal can still inspect resources as
  an operator path.
