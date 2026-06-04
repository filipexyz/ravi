---
id: a2a/registry
title: "A2A Remote Agent Registry"
kind: capability
domain: a2a
capability: registry
tags:
  - a2a
  - registry
  - agent-card
  - discovery
  - authorization
applies_to:
  - src/a2a/registry.ts
  - src/a2a/registry-db.ts
  - src/a2a/auth.ts
  - src/cli/commands/a2a.ts
  - src/router/router-db.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# A2A Remote Agent Registry

## Intent

The A2A registry is Ravi's durable source of truth for remote agents that can be
called programmatically. It turns discovered Agent Cards into audited,
permissioned, refreshable Ravi records.

## Data Model

The registry SHOULD introduce tables equivalent to:

- `a2a_agents`
  - `id` stable Ravi id, unique
  - `name`, `description`, `provider_name`, `provider_url`
  - `card_url`, `card_json`, `card_etag`, `card_fetched_at`, `card_expires_at`
  - `selected_interface_json`, `interfaces_json`
  - `protocol_version`, `protocol_binding`
  - `capabilities_json`, `skills_json`, `security_schemes_json`
  - `security_requirements_json`, `skill_security_requirements_json`
  - `auth_policy_json`
  - `trust_level` (`untrusted`, `trusted`, `internal`)
  - `enabled`
  - `default_auth_binding_id`
  - `owner_agent_id`, `tenant_id`, `tags_json`
  - `last_health_status`, `last_health_at`, `last_error`
  - `created_at`, `updated_at`
- `a2a_invocations`
  - correlation fields for outbound calls and remote task ids, owned mainly by
    `a2a/client` but keyed to `a2a_agents.id`.

## Rules

- `a2a_agents.id` MUST be a Ravi-local stable id. It MUST NOT be derived from a
  mutable display name alone.
- Registry writes MUST be explicit operator or trusted automation actions.
  Merely receiving a URL in chat MUST NOT auto-register a remote agent.
- Discovery MUST fetch the Agent Card, validate required fields, record the raw
  card, and project a normalized summary.
- Discovery MUST prefer an explicit card URL when provided. For base URLs it
  MUST try `/.well-known/agent-card.json`; legacy paths MAY be tried only with a
  compatibility marker.
- Production registry entries SHOULD require HTTPS card and interface URLs.
  Localhost and private dev URLs MAY be allowed behind an explicit dev flag.
- Agent Cards MUST be treated as untrusted metadata until the entry is enabled
  and assigned a trust level.
- Registry refresh MUST NOT delete the previous known-good card when a refresh
  fails. It SHOULD record `last_error` and keep the entry disabled only if the
  operator or policy says so.
- When an Agent Card carries signatures, Ravi SHOULD verify them before raising
  trust above `untrusted`.
- `securitySchemes`, top-level `security`, and skill-level security
  requirements MUST be persisted as metadata. Actual credentials MUST live in
  Ravi credential infrastructure and be referenced through `a2a/auth` bindings.
- Enabling a remote agent MUST NOT imply every local agent/session may call it.
  Registry enablement only marks the target usable by policy; caller
  authorization remains separate.
- Registry trust level MUST NOT be raised solely because the Agent Card declares
  an authentication scheme. Trust requires operator approval, trusted discovery,
  signature verification, or another explicit trust signal.
- Registry list/search results MUST expose safe summaries by default. Raw cards,
  raw headers, and diagnostic provenance SHOULD require an explicit
  `--include-raw` or equivalent option.

## CLI And SDK Surface

The decorated CLI SHOULD expose:

```bash
ravi a2a agents list --json
ravi a2a agents show <id> --json
ravi a2a agents discover <base-or-card-url> --id <id> --json
ravi a2a agents refresh <id> --json
ravi a2a agents enable <id> --trust trusted --json
ravi a2a agents disable <id> --json
ravi a2a agents remove <id> --json
```

These commands SHOULD use `@Returns(zod)` so SDK clients can call the registry
programmatically.

## Acceptance

- A valid A2A 1.0 Agent Card can be discovered from
  `https://host/.well-known/agent-card.json`.
- A remote agent can be listed, shown, refreshed, disabled, and removed without
  touching local Ravi `agents`.
- A refresh failure keeps the previous card and records the failure.
- Registry commands return deterministic JSON for gateway/SDK use.

## Known Failure Modes

- Trusting card-provided skill names as executable permissions.
- Storing credentials in `card_json` or `security_schemes_json`.
- Treating `default_auth_binding_id` as global permission for all callers.
- Replacing a good card with a broken refresh response.
- Making URL discovery available to any runtime prompt without permission.
