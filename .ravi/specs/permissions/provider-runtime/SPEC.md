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
  - migration
tags:
  - permissions
  - provider-runtime
  - migration
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

Ravi core MUST NOT embed a native grant graph as authorization logic. The core runtime,
CLI, SDK gateway, app router, bash hook, approval flow, and context registry
MUST call a provider runtime facade instead of importing permission engines,
capability evaluators, or grant stores.

The target architecture is:

```text
caller -> Permission Provider Runtime -> provider chain -> decision/audit
```

No caller should know whether the decision came from an app-owned provider, a
local operator provider, a static bootstrap provider, a future external policy
provider, or a legacy relation-backed provider if one is explicitly configured.

App permission provider execution is part of this runtime boundary. App routers
MUST NOT implement provider request construction, subprocess env redaction,
decision schema validation, timeout handling, or provider deny composition
locally. They may resolve an app operation, then call the Permission Provider
Runtime and attach the returned audit metadata to the app operation result.

## Core Responsibilities

Ravi core owns only authorization plumbing:

- resolve canonical runtime context from `RAVI_CONTEXT_KEY` or explicit local
  operator context;
- resolve canonical principals: actor, surface, session, executor agent,
  automation, app, and resource;
- build a typed authorization request;
- select and execute configured providers;
- enforce timeout, output-size, schema, redaction, and fail-closed behavior;
- combine provider decisions according to declared composition rules;
- emit structured audit/explain metadata.

Ravi core MUST NOT own domain policy.

Ravi core MUST NOT contain hardcoded grant semantics such as
`agentCan`, `canWithCapabilityContext`, `hasRelation`, role expansion,
toolgroup expansion, wildcard grants, or relation lifetime checks outside a
provider implementation.

## Provider Responsibilities

A permission provider answers:

> Given this typed request and canonical context, should this action be allowed,
> denied, or require approval now?

Providers MAY own:

- relation graphs;
- app-domain ACLs;
- resource ownership;
- external provider ACL sync;
- local operator bootstrap policy;
- break-glass policy;
- approval/grant application for their own policy state.

Providers MUST NOT mutate another provider's policy state.

Providers MUST NOT receive raw context keys, bearer tokens, credentials, cookies,
or unredacted secret-like arguments unless the provider is the trusted local core
process and the spec explicitly allows that path.

## Authorization Request

Every check MUST use a structured request:

```json
{
  "schema": "ravi.permission.request/v1",
  "requestId": "string",
  "relation": "execute",
  "object": { "type": "group", "id": "sessions_info" },
  "operation": {
    "surface": "cli",
    "group": "sessions",
    "command": "info",
    "mutating": false
  },
  "resource": {
    "type": "session",
    "id": "main"
  },
  "context": {
    "contextId": "ctx_redacted",
    "authorityMode": "delegated",
    "actor": { "type": "contact", "id": "contact_luis" },
    "surface": { "type": "chat", "id": "chat_group_1" },
    "session": { "id": "session_main", "name": "main" },
    "executorAgent": { "id": "dev" }
  },
  "input": {
    "args": [],
    "options": {},
    "redacted": true
  }
}
```

Rules:

- `relation`, `object.type`, and `object.id` MUST be canonical.
- Raw channel ids MAY appear only as provenance, never as authority.
- The request MUST distinguish actor authority from executor-agent ceiling and
  surface constraints.
- Operation input MUST be selected and sanitized. Full user payloads MUST NOT be
  sent by default.

## Provider Decision

Providers MUST return one of:

- `allow`
- `deny`
- `needs_approval`
- `not_applicable`

Initial shape:

```json
{
  "schema": "ravi.permission.decision/v1",
  "providerId": "context-capabilities",
  "providerVersion": "2026-06-14",
  "decision": "allow",
  "reasonCode": "context_capabilities_allow",
  "reason": "runtime context has execute group:sessions_info",
  "evidence": [
    {
      "kind": "capability",
      "relation": "execute",
      "object": "group:sessions_info",
      "source": "context"
    }
  ],
  "grantSuggestion": null,
  "cache": { "ttlSec": 30 }
}
```

Rules:

- `allow` MUST include a stable `reasonCode`.
- `deny` SHOULD include a user-safe reason and operator-safe evidence.
- `needs_approval` MUST deny the protected operation until approval is applied.
- `needs_approval` MAY include a provider-owned grant suggestion.
- A provider's grant suggestion MUST NOT be applied by another provider.
- `not_applicable` means the provider did not own the requested decision.

## Composition

Provider composition MUST be explicit.

The default composition is:

1. If no provider is configured for the request class, deny.
2. Required provider error, timeout, invalid output, or schema mismatch denies.
3. Any required provider `deny` denies.
4. Any required provider `needs_approval` denies and returns approval metadata.
5. All required providers `allow` permits.
6. Optional providers may enrich audit or apply visibility filters, but MUST NOT
   override a required provider denial.

Provider runtime MAY support specialized policies such as first-match or
fallback, but those policies MUST be declared and audited.

## Context Capabilities Provider

The `context-capabilities` provider owns authorization from already materialized
runtime capability snapshots. It is the default runtime provider for requests
that include `context` or explicit `capabilities`.

It MUST NOT read relation-store grants, roles, live agent grants, or policy
materialization tables. Runtime contexts are the authority snapshot.

Rules:

- `context-capabilities` MUST authorize only from `ContextCapability[]`.
- Direct subject-only requests without a context MUST fail closed unless another
  explicitly configured provider supports that request class.
- Relation-store compatibility providers MUST NOT be configured by default.
- New code MUST NOT add direct dependencies on
  `src/permissions/capability-context.ts`, `src/permissions/relations.ts`, or
  `src/permissions/scope.ts`.

## Capability Materialization

Authorization and capability materialization are separate provider-runtime
surfaces.

Authorization answers "may this request run now?". Materialization answers
"which capability snapshot should be placed in a runtime context for this
principal?". Both MUST be called through `src/permissions/provider-runtime.ts`.

Default runtime authorization providers:

1. `local-operator` for explicit local bootstrap calls with no
   subject/context/capabilities and `localOperator=true`.
2. `context-capabilities` for runtime requests with a context or explicit
   `ContextCapability[]`.

Default capability materializers:

1. `runtime-bootstrap`, as the explicit non-relation bootstrap materializer
   while concrete app/domain providers are introduced.

Rules:

- `local-grants` MUST NOT be registered in the default authorization provider
  chain or the default capability materializer chain.
- Relation-store grants MUST NOT seed runtime context snapshots through default
  provider-runtime materialization.
- `runtime-bootstrap` MUST materialize executor subjects only (`agent` and
  `automation`). It MUST return no capabilities for actor/surface subjects such
  as `contact` and `chat`.
- `runtime-bootstrap` MUST NOT grant `admin` authority, group administration, or
  toolgroup administration. It may temporarily bridge ordinary executor
  operation (`use tool:*`, `execute group:*`, safe executables) until concrete
  app/domain providers replace it.
- A relation-store grant MUST NOT make a direct subject-only authorization
  request pass unless an operator explicitly configures a provider for that
  request class.
- Runtime hooks that execute before a full runtime context is available MAY
  materialize the current agent's capabilities through the provider-runtime
  materializer. This is only for local root agent execution paths such as the
  Bash and SDK tool pre-use hooks.
- When a hook receives an explicit delegated context, it MUST remain
  snapshot-bound. Live materialization MUST NOT expand `turn-runtime`,
  `invocation-runtime`, or `metadata.authorityMode=delegated` authority.
- Non-delegated stale snapshots MAY honor a live `admin system:*` capability
  for break-glass/superadmin behavior, but ordinary live grants MUST NOT bypass
  non-root snapshots.
- Runtime context creation MUST NOT import relation stores or local-grants
  materializers directly.
- Removing the compatibility materializer MUST be possible without changing
  runtime authorization call sites.

## Local Operator and Bootstrap

Direct local CLI execution without a runtime principal MUST NOT be a hidden
global allow inside callers.

It MAY be authorized by a `local-operator` provider that is active only when:

- the authorization request explicitly sets `localOperator=true`;
- no `RAVI_CONTEXT_KEY` exists;
- no `agentId` exists;
- no subject or capability snapshot is provided;
- the caller is a local process;
- the command is not explicitly marked as requiring runtime identity.

Bootstrap providers MUST be narrow, named, and auditable.

## Migration Rules

- The provider runtime facade MUST stay in place as the only public authorization API.
- Existing behavior MAY be intentionally replaced by new providers, but all
  callers MUST use the facade.
- After call-site migration, direct grant-evaluator/grant-store imports become
  test failures.
- App-owned providers SHOULD be migrated after the platform provider facade is
  in place, not before.
- Relation-store CLI commands may remain only as legacy ledger administration
  commands and MUST NOT imply default runtime authorization.
- Specs that refer to a native grant graph as Ravi core MUST be updated to refer
  to provider runtime or a concrete provider.

## Production Readiness Gates

The provider runtime is production-ready only when these gates are enforced by
tests:

- `src/permissions/engine.ts` MUST NOT exist.
- `src/permissions/provider-runtime.ts` MUST NOT import relation stores,
  relation-backed evaluators, legacy grant providers, or capability-context
  evaluators directly.
- Runtime source outside `src/permissions` MUST NOT import
  `src/permissions/relations.ts`, `src/permissions/capability-context.ts`, or a
  native permission engine.
- The default authorization provider chain MUST be exactly `local-operator` plus
  `context-capabilities` unless an explicit production config changes it.
- The relation-store `local-grants` provider MUST NOT remain in the default
  capability materializer chain.
- The default capability materializer chain MUST keep `runtime-bootstrap`
  limited to `agent` and `automation` subjects and MUST NOT materialize
  `contact` or `chat` subjects.
- App permission provider execution MUST be reachable from app routers only
  through `src/permissions/provider-runtime.ts`.
- Every provider-runtime decision MUST carry a `requestId`, `providerId`,
  `providerVersion`, canonical permission/object fields, stable `reasonCode`,
  boolean `allowed`, and `durationMs`.
- Any new provider MUST fail closed on error, invalid output, timeout, schema
  mismatch, or required-provider `not_applicable`.

## Acceptance Criteria

- There is a single public authorization facade for runtime, CLI, SDK gateway,
  app router, bash hook, approvals, context registry, and domain modules.
- Runtime code does not import grant evaluators or relation stores directly.
- `src/permissions/provider-runtime.ts` does not import relation stores or
  relation-backed evaluators directly.
- Runtime context creation uses provider-runtime capability materializers rather
  than relation-store helpers.
- Relation-store local grants are not part of the default authorization provider
  chain or default capability materializer chain.
- App routers do not contain app permission provider execution internals; those
  live under the Permission Provider Runtime.
- Provider decisions include provider id/version, request id, canonical
  principals when available, relation/object/resource, decision, reason code,
  evidence when available, and duration.
- Provider subprocesses and external providers receive redacted env/input.
- Tests cover deny-by-default when no provider is configured.
- Tests cover context-capability authorization without relation-store grants.
- Tests cover that relation-store grants do not authorize the default provider
  chain.
- Tests cover that relation-store grants do not materialize into default runtime
  context snapshots.
- Tests cover that missing subject/context denies by default and explicit
  `localOperator=true` is required for local-operator authorization.
- Tests cover that `runtime-bootstrap` returns no `contact`/`chat` capabilities
  and no admin capabilities for agent/automation bootstrap snapshots.
