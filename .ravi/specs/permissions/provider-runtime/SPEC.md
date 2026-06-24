---
id: permissions/provider-runtime
title: "Permission Provider Runtime"
kind: capability
domain: permissions
capability: provider-runtime
capabilities:
  - provider-runtime
  - authorization
  - providers
  - audit
tags:
  - permissions
  - provider-runtime
applies_to:
  - src/permissions
  - src/runtime
  - src/apps
  - src/bash
  - src/sdk/gateway
  - src/cli
owners:
  - ravi-dev
status: active
normative: true
---

# Permission Provider Runtime

## Intent

The Permission Provider Runtime is the only authorization surface in Ravi.

Ravi core owns authorization plumbing: context resolution, canonical
principals, provider registry, bounded execution, provider composition, audit,
and resource-visibility filtering. Domain policy lives in providers or in
provider-owned subject configuration.

## Default Providers

Required authorization providers:

- `local-operator`: explicit local bootstrap path.
- `context-capabilities`: checks already materialized runtime snapshots.

Required capability materializers:

- `runtime-bootstrap`
- `agent-runtime-permissions`
- `agent-identity-permissions`
- `contact-policy-permissions`

## Rules

- Runtime code MUST call the provider-runtime facade for authorization.
- Runtime context creation MUST materialize subject capabilities through the
  registered materializer chain.
- `ravi permissions status/check/materialize` MUST remain inspection-only.
- `ravi permissions allow/resolve` MUST be provider-owned orchestration only:
  it may create/update permission-scoped tags, attach contact policy tags, and
  ensure agent runtime ceilings, but MUST NOT write to a native permission
  graph.
- Agent authority changes MUST use provider-owned config, currently
  `agent.defaults.runtimePermissions` via `ravi permissions allow/resolve` or
  direct agent-only `ravi agents permissions`.
- External shared-surface turns MUST use `agent-identity-permissions` as the
  production authority projection. Contact and chat principals remain
  provenance/invocation context unless a future overlay provider explicitly
  gates them.
- Denial resolution for `authorityMode=agent-identity` MUST apply recurring
  capability to `agent:<executorAgentId>`, not to `contact:<actorId>`.
- Direct local execution MAY be allowed only through the explicit
  `local-operator` provider.
- A no-subject/no-context request without explicit local-operator intent MUST
  deny.
- Resource discovery is authorization. List/show/search surfaces MUST filter by
  provider-runtime visibility capabilities.
- Provider errors, timeouts, malformed output, and required provider denials
  MUST fail closed.

## Agent Visibility Migration

- DB initialization MUST ensure the default agent has provider-owned
  `view agent:*`.
- `agents create` under a runtime creator MUST persist
  `view agent:<created-id>` for that creator through provider-owned config.
- WhatsApp group creation with `--create-agent` MUST apply the same creator
  visibility rule.
- The migration MUST be idempotent and MUST NOT depend on removed command
  paths.
