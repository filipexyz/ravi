---
id: permissions
title: "Permissions"
kind: domain
domain: permissions
capabilities:
  - rebac
  - delegation
  - resource-visibility
  - profiles
  - runtime-context
  - least-privilege
tags:
  - permissions
  - rebac
  - runtime
  - security
applies_to:
  - src/permissions
  - src/runtime
  - src/contacts.ts
  - src/omni/consumer.ts
  - src/router/router-db.ts
owners:
  - ravi-rebac
  - ravi-dev
status: active
normative: true
---

# Permissions

## Intent

Ravi permissions define who can cause Ravi to read, execute, mutate, deliver, or disclose state.

The permission model MUST protect every authority-bearing surface: SDK tools, CLI groups, executables, sessions, contacts, chats, contexts, automations, observers, triggers, cron jobs, providers, and external gateways.

## Invariants

- Ravi MUST fail closed when the effective principal, object, relation, or context cannot be resolved.
- Permission checks MUST use canonical Ravi subjects and objects, not raw provider ids, display names, phone numbers, or chat titles.
- Contacts, agents, chats, sessions, automations, observers, roles, and system actors are distinct principals. A grant to one MUST NOT imply a grant to another unless an explicit relation says so.
- Groups/chats/threads are communication surfaces, not human users. They MAY constrain authority, but they MUST NOT replace the current actor principal.
- `contact_policies` status controls operational intake and reply eligibility. It MUST NOT be treated as tool/executable/CLI authorization by itself.
- Any policy that affects tool, executable, CLI, session, contact, or gateway authority MUST be represented in the permission graph or in a runtime capability context derived from that graph.
- Runtime contexts MUST carry enough structured authority provenance to explain why a tool was allowed or denied.
- Runtime providers MUST be adapters. They MUST NOT create a provider-private permission model that can bypass Ravi REBAC.
- Discovery MUST be treated as disclosure. Runtime list, show, search, check,
  autocomplete, alias resolution, SDK discovery, and UI picker surfaces MUST
  filter to resources visible to the effective context.

## Subject Types

The permission graph MAY contain multiple subject types. These are the canonical meanings:

- `agent`: Ravi agent identity and maximum technical authority.
- `contact`: canonical human or organization from `chat.db.contacts`.
- `platform_identity`: channel-specific identity linked to a contact or agent.
- `chat`: canonical communication surface from `ravi.db.chats`.
- `session`: runtime session.
- `role`: reusable authority bundle, similar to a Discord role.
- `automation`: cron, trigger, observer, workflow, or daemon-originated actor.
- `system`: break-glass or platform-owned actor.

## Authority Rule

External user-initiated execution MUST be authorized by the actor who caused the turn, the chat/surface where it happened, and the agent that will execute it.

Agent permission is a ceiling, not sufficient authority.

## Grant Lifetime

REBAC grants MUST carry lifetime metadata.

Canonical relation metadata:

- `grant_mode`: `temporary` or `permanent`.
- `expires_at`: epoch seconds when a temporary grant stops authorizing.
- `revoked_at`: epoch seconds when a grant was revoked.
- `reason`: optional operator/audit reason.
- `issued_by`: optional context/session/agent/operator that issued the grant.

Rules:

- New manual grants MUST be temporary by default.
- `permissions grant` and `permissions init` MUST require an explicit `--permanent` flag to create permanent manual grants.
- CLI-created temporary grants SHOULD default to a short TTL; the current default is one hour.
- `--ttl` and `--expires-at` MAY override the default temporary expiration.
- Grants from config/bootstrap/test/calendar sync MAY remain permanent unless they pass explicit lifetime metadata.
- Existing legacy rows without lifetime metadata MUST be interpreted as permanent for compatibility, not silently expired.
- Authorization checks MUST ignore expired or revoked grants.
- Operator/audit listing MUST be able to include expired and revoked grants without making them active again.

## App Objects

Apps are first-class REBAC objects.

- Non-mutating app operations require `use app:<app-id>` when executed under an agent/runtime context.
- Mutating app operations require `execute app:<app-id>` when executed under an agent/runtime context.
- App manifest permissions describe app-level requirements. They are not grants.
- Direct local CLI execution with no principal MAY remain a break-glass operator path, but any runtime execution with `agentId` MUST authorize against `app:<id>`.

## Resource Visibility

Resources MUST be isolated by default.

Canonical visibility relations:

- `view agent:<id>` for agent discovery beyond self.
- `access session:<id>` for session read/trace/list visibility beyond own
  session.
- `modify session:<id>` for session mutation beyond own session.
- `use app:<id>` for app discovery, manifest inspection, checks, help, and
  non-mutating app operations.
- `read_contact contact:<id>`, `read_own_contacts system:*`,
  `read_tagged_contacts system:<tag>`, or `write_contacts system:*` for
  contact discovery and reads.

Direct local CLI execution without a resolved principal MAY remain a full local
operator view. Runtime execution with an `agentId` MUST NOT use local discovery
as an authorization bypass.

Broad discovery surfaces MUST filter unauthorized rows. Direct lookups for
hidden resources SHOULD use a not-found-equivalent response to avoid
enumeration.

## Permission Profiles

Reusable permission groups SHOULD be modeled as `role:<id>` subjects/objects.

Roles are capability bundles, not ambient grants. A role/profile grants
authority only when a principal is explicitly linked to it, for example:

```text
role:trusted-dev use app:khal-tasks
role:trusted-dev execute app:khal-tasks
contact:<contact-id> member role:trusted-dev
```

Profile expansion MUST preserve provenance and MUST occur before delegated
authority intersection. A chat/session/route profile assignment constrains the
surface; it MUST NOT replace the actor principal or expand authority absent
from the actor and agent ceilings.

## CLI Scope Boundary

Decorator scope `open` MUST NOT be treated as authorization bypass for runtime
execution.

- Direct CLI execution without a resolved principal MAY run `open` commands.
- When `agentId` or a runtime context exists, `open` commands MUST require
  `execute group:<group>` or `execute group:<group>_<command>`.
- `resource` scope MAY still perform resource-owner checks in the command layer,
  but it MUST NOT be used for sensitive mutation without a resource owner.
- Sensitive command groups SHOULD migrate away from `open` once their resource
  object model is explicit.

## Grant Notifications

When an operator creates manual grants through the permissions CLI, Ravi SHOULD emit a session prompt to currently affected sessions.

Minimum behavior:

- `agent:<id>` grants notify active sessions for that agent.
- `session:<id>` subject/object grants notify that concrete session.
- Notifications are advisory. Failure to publish a notification MUST NOT roll back the grant.
- The permission graph and denial ledger remain authoritative; the notification only lets a previously blocked session retry.

## Audit Denied Provenance

`ravi.audit.denied` MUST carry enough safe runtime provenance for an auditor to distinguish agent grants from delegated turn authority.

Minimum event fields:

- `type`, `agentId`, `denied`, `reason`, `dedupeKey`.
- `dedupeKey` MUST be stable for semantically equivalent denials and MUST NOT include `denialId`, timestamps, context keys, or other per-attempt entropy.
- `command` when a CLI or Bash command caused the denial.
- `denialId` when the denial was persisted in `permission_denials`.
- `context.contextId`, `context.kind`, `context.sessionKey`, `context.sessionName`.
- Delegated authority metadata when present: `authorityMode`, `authorityResolver`, `actorPrincipal`, `actorResolution`, `surfacePrincipal`, `executorAgentId`.
- Capability counts when present: `actorCapabilityCount`, `surfaceCapabilityCount`, `turnCapabilityCount`, `effectiveCapabilityCount`, `capabilitiesCount`.

The audit event and `permission_denials.detail_json` MUST NOT include `contextKey`, raw secret env values, credentials or arbitrary runtime metadata.
