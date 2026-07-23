---
id: apps/permission-providers
title: "App Permission Providers"
kind: capability
domain: apps
capabilities:
  - permission-providers
  - app-authorization
  - manifest
  - policy
  - audit
tags:
  - apps
  - permissions
  - authorization
  - policy
applies_to:
  - .ravi/specs/apps
  - src/apps
  - src/permissions
  - src/runtime
  - src/cli/commands/apps.ts
owners:
  - ravi-dev
status: active
normative: true
---

# App Permission Providers

## Intent

App Permission Providers let Ravi Apps own domain-specific authorization inside
the global Permission Provider Runtime.

The goal is to avoid encoding every app's resource rules into Ravi core while
preserving fail-closed execution, canonical actor identity, auditable decisions,
  provider-owned authority, and runtime context isolation.

An app permission provider answers this question:

> Given this canonical Ravi actor/surface/session/agent context, may this app
> operation act on this app resource now?

It is an app-domain provider in the same provider runtime used by the rest of
Ravi. It does not bypass other required providers.

## Invariants

- Ravi core MUST NOT embed any grant graph as the outer guardrail. Ravi core owns only
  provider-runtime plumbing: context resolution, canonical principals, provider
  registry, bounded execution, composition, redaction, and audit.
- Platform authority such as app visibility, agent ceilings, break-glass, and
  temporary grant lifetime MUST be decided by configured permission providers,
  not by app code and not by direct imports of unrelated provider storage in Ravi core.
- App Permission Providers MUST be executed by the Permission Provider Runtime,
  not by router-local app code.
- App Permission Providers MUST decide only app-owned domain rules. Examples:
  `calendar:event:write`, `mailbox:item:read`, `crm:opportunity:update`, or
  app-specific resource visibility.
- A provider decision MUST NOT bypass context-key authorization, skill gates, or
  another required provider's denial.
- A provider decision MUST NOT mutate another provider's policy state. It MAY
  return a grant suggestion, but applying that suggestion remains a separate
  provider-owned permission operation with normal lifetime, approval, and audit
  rules.
- A provider MUST receive canonical Ravi principals and objects, not raw channel
  ids, display names, phone numbers, session labels, or prompt text as
  authority.
- A provider MUST fail closed when the actor, surface, session, app, operation,
  provider, schema, or resource cannot be resolved.
- A provider error, timeout, invalid response, unknown decision, or schema
  mismatch MUST deny any operation that requires that provider.
- Provider decisions MUST be deterministic for the same request snapshot unless
  the provider explicitly depends on current state and reports that state in
  audit metadata.
- Provider decisions MUST be auditable. The runtime MUST be able to explain:
  - which app provider was asked;
  - which actor/surface/session/agent/app/operation/resource was checked;
  - which core guardrail result preceded the provider;
  - the provider decision, reason code, and safe evidence;
  - whether a grant suggestion was returned;
  - whether any cache entry was used.
- Provider decision payloads MUST NOT include secrets, raw context keys,
  credentials, bearer tokens, or arbitrary private app state.
- Provider checks MUST be bounded by timeout and output-size limits.
- Provider decisions MAY be cached only when the provider declares a safe cache
  TTL and the cache key includes actor, surface, session authority mode, app id,
  operation id, resource id, action, provider version, and relevant policy
  version.
- Cache invalidation MUST happen on provider version changes, relevant app
  manifest changes, provider-owned grant/policy events affecting the request
  principals, app-owned policy changes, and resource ownership/visibility
  changes.
- App providers MUST support dry-run/explain mode before they are used to block
  or allow production operations.
- App providers SHOULD be app-local and versioned with the app manifest.
- First-party providers SHOULD expose tests that run without external network or
  real user credentials.

## Runtime Boundary

App routers and app services are not authorization runtimes.

Rules:

- `src/apps/router.ts` MAY resolve manifests, operations, interfaces, arguments,
  and built-in handlers.
- `src/apps/router.ts` MUST NOT build provider request schemas, validate provider
  decisions, run provider subprocesses, redact provider env, enforce provider
  timeouts, or compose provider denials locally.
- App provider execution MUST be called through
  `src/permissions/provider-runtime.ts`.
- `src/permissions/app-permission-provider-runtime.ts` is an implementation
  detail of the Permission Provider Runtime and MUST NOT be imported directly by
  app code.
- Production tests MUST guard this boundary.

## Authorization Pipeline

The normative pipeline is:

1. Resolve runtime context from `RAVI_CONTEXT_KEY`.
2. Resolve canonical actor principal, surface principal, session, and executor
   agent.
3. Ask the Permission Provider Runtime for the platform/app boundary decision:
   - context exists and is not revoked;
   - configured providers allow app visibility and operation class;
   - app object boundary allows an equivalent of `use app:<app-id>` for
     non-mutating operations or `execute app:<app-id>` for mutating operations,
     when such a provider is configured.
4. Resolve the app operation and resource.
5. If the operation declares or inherits a permission provider, the app router
   MUST call the Permission Provider Runtime to execute that provider with the
   request envelope.
6. Combine decisions:
   - provider-runtime boundary deny => deny;
   - provider deny => deny;
   - provider needs_grant => deny with grant suggestion;
   - provider allow + required boundary providers allow => allow;
   - provider not_applicable on a provider-required operation => deny.
7. Emit audit/explain metadata.

## Manifest Contract

Apps MAY declare a permission provider under `permissions.provider`.

Initial shape:

```json
{
  "permissions": {
    "required": ["calendar:read"],
    "mutating": ["calendar:write"],
    "provider": {
      "id": "calendar.local",
      "version": "2026-06-13",
      "interface": "builtin",
      "operation": "calendar.permissions.decide",
      "decisionSchema": "schemas/permission-decision.v1.json",
      "requestSchema": "schemas/permission-request.v1.json",
      "timeoutMs": 500,
      "cacheTtlSec": 30,
      "failClosed": true,
      "scope": ["visibility", "operation", "resource"]
    }
  }
}
```

Rules:

- `permissions.provider.id` MUST be stable within the app.
- `permissions.provider.version` MUST change when provider semantics change.
- `interface` MUST be a bounded request/response app operation interface.
  Current implementation supports `builtin` and `cli`. `sdk` and `tool` are
  reserved until the runtime has bounded request/response executors for them.
  Stream interfaces MUST NOT be used for permission provider decisions.
- Provider operations MUST be safe to call for authorization. They MUST NOT
  perform the protected mutation as a side effect.
- Provider operations MUST return JSON matching the declared decision schema.
- Manifest discovery MUST validate provider metadata without executing the
  provider.
- A manifest MAY omit an app-domain provider for apps whose permissions are
  fully covered by non-app providers configured in the Permission Provider
  Runtime.
- A provider declaration is not a grant. It is a decision hook.

## Provider Request Envelope

The provider request MUST be a structured object with this minimum shape:

```json
{
  "schema": "ravi.app.permission.request/v1",
  "requestId": "string",
  "appId": "calendar",
  "providerId": "calendar.local",
  "providerVersion": "2026-06-13",
  "operation": {
    "id": "calendar.events.create",
    "mutating": true,
    "action": "create",
    "declaredPermissions": ["calendar:write"]
  },
  "resource": {
    "type": "calendar",
    "id": "cal_local_123",
    "owner": { "type": "contact", "id": "contact_123" }
  },
  "input": {
    "args": [],
    "options": { "calendar": "cal_local_123" },
    "rawArgCount": 2,
    "redacted": false
  },
  "context": {
    "contextId": "ctx_redacted",
    "authorityMode": "delegated",
    "session": { "id": "session_123", "name": "main" },
    "actor": { "type": "contact", "id": "contact_123" },
    "surface": { "type": "chat", "id": "chat_123" },
    "executorAgent": { "id": "dev" }
  },
  "core": {
    "appBoundary": "allow",
    "agentCeiling": "allow",
    "surfaceConstraint": "allow"
  }
}
```

Rules:

- `contextId` MAY be a safe redacted/id-only reference. Raw context keys MUST
  NOT be sent to providers unless the provider is the trusted core runtime.
- The envelope MUST include enough app/resource context for a provider to decide
  without querying unrelated global state.
- Resource ownership SHOULD be canonical (`contact`, `agent`, `team`, `system`,
  or app-owned object), not implicit in a title or raw provider id.
- Operations MAY declare `authorization.resource` to derive provider resource
  type/id/owner from a static id, positional arg, named option, or context
  principal (`actor`, `surface`, `executorAgent`).
- Operations MAY declare `authorization.input.includeArgs` and
  `authorization.input.includeOptions` to pass selected, sanitized operation
  input fields into the provider envelope.
- The runtime SHOULD pass only the operation input fields needed for the
  authorization decision. Full user payloads SHOULD NOT be sent by default.
- Provider subprocesses MUST NOT inherit raw context-key or credential
  environment variables. Normal app operations may receive runtime context env;
  provider hooks are a stricter policy boundary.
- The operation referenced by `permissions.provider.operation` is reserved for
  the runtime authorization path and MUST NOT be directly runnable as an ordinary
  app operation unless a future diagnostic spec defines that behavior.

## Provider Decision Contract

The provider MUST return one of:

- `allow`
- `deny`
- `needs_grant`
- `not_applicable`

Initial shape:

```json
{
  "schema": "ravi.app.permission.decision/v1",
  "decision": "allow",
  "reasonCode": "owner_match",
  "reason": "Actor owns the target calendar.",
  "visibility": "visible",
  "resource": {
    "type": "calendar",
    "id": "cal_local_123"
  },
  "grantSuggestion": null,
  "audit": {
    "policyVersion": "2026-06-13",
    "evidence": ["resource.owner == actor"]
  },
  "cache": {
    "ttlSec": 30
  }
}
```

Grant suggestion shape:

```json
{
  "decision": "needs_grant",
  "reasonCode": "missing_calendar_write",
  "grantSuggestion": {
    "subject": { "type": "contact", "id": "contact_123" },
    "relation": "write",
    "object": { "type": "app-resource", "id": "calendar:cal_local_123" },
    "ttlSec": 3600,
    "reason": "Allow this actor to create events on this calendar for one hour."
  }
}
```

Rules:

- `allow` MUST include a stable `reasonCode`.
- `deny` SHOULD include a user-safe reason and an operator-safe audit reason.
- `needs_grant` MUST deny the operation. It is not an implicit approval.
- Grant suggestions MUST default to temporary grants.
- Grant suggestions MUST NOT propose broad wildcard grants unless the provider
  is a core-approved admin provider and the current context is break-glass.
- `not_applicable` is valid only when the provider is optional for that
  operation. Provider-required operations MUST treat `not_applicable` as deny.

## Resource Visibility

Discovery is disclosure. If an app provider owns resource visibility, list/show
surfaces MUST call the provider or a provider-backed visibility index before
returning resources.

Rules:

- Hidden resources SHOULD appear missing rather than permission-denied on direct
  lookup unless the caller has diagnostic authority.
- Broad list/search/autocomplete surfaces MUST filter by provider decision.
- Provider-backed visibility MUST compose with provider-runtime app visibility.
  An actor without a provider-runtime decision equivalent to `use app:<app-id>`
  MUST NOT discover app resources even if an app-domain provider would allow the
  resource.

## Boundaries

- App Permission Providers are provider-runtime participants. They MAY decide
  app-domain policy, but they do not become a separate authorization surface
  outside the Permission Provider Runtime.
- Providers do not own the context registry.
- Providers own only their own policy/grant state.
- Providers do not mutate another provider's grants or policy state.
- Providers do not bypass required provider-runtime decisions equivalent to
  `use/execute app:<id>`.
- Providers do not authorize direct local operator break-glass behavior.
- Providers MUST NOT depend on natural-language prompt annotations for identity.
- Providers MUST NOT scrape chat history to infer authority when structured
  actor/resource metadata is available.

## Validation

- `ravi specs get apps/permission-providers --mode rules --json` MUST return
  this contract.
- `ravi specs get apps/manifest --mode rules --json` SHOULD remain compatible
  with provider declarations.
- App manifest validation SHOULD reject malformed provider metadata.
- App router tests SHOULD prove provider-required operations deny on provider
  timeout, provider error, invalid schema, `not_applicable`, and required
  provider denial.
- App router tests SHOULD prove provider allow cannot exceed missing
  provider-runtime `use/execute app:<id>` equivalents or executor agent ceiling.
- App router tests SHOULD prove `needs_grant` returns a denial with grant
  suggestion and does not mutate provider-owned policy state.
- Provider audit tests SHOULD prove context keys and secrets are not serialized.

## Known Failure Modes

- Treating an app-domain provider `allow` as stronger than a required
  provider-runtime denial makes an app a privilege escalation path.
- Treating provider `needs_grant` as approval executes the protected operation
  without operator/user intent.
- Letting providers mutate each other's policy creates hidden authority changes
  outside the owning provider.
- Sending raw context keys or credentials to provider operations leaks runtime
  authority.
- Running providers during manifest discovery creates startup side effects and
  supply-chain risk.
- Caching provider decisions without policy/resource version keys leaks stale
  access after revocation or ownership change.
- Using raw WhatsApp ids, display names, or prompt text as provider authority
  repeats the identity bugs the permission layer is meant to prevent.
