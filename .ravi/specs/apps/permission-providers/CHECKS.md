# App Permission Providers / CHECKS

## Spec Checks

```bash
ravi specs get apps/permission-providers --mode rules --json
ravi specs get apps/permission-providers --mode full --json
ravi specs get permissions/provider-runtime --mode rules --json
ravi specs get apps/manifest --mode rules --json
ravi specs get apps/router --mode rules --json
ravi specs sync --json
```

## Manifest Checks

- A manifest with `permissions.provider` and missing `id` fails validation.
- A manifest with `permissions.provider` and missing `version` fails
  validation.
- A manifest with unknown provider `interface` fails validation.
- A manifest with provider timeout above the runtime maximum fails validation
  or warns with a bounded clamp.
- A manifest with provider operation pointing to a mutating/protected operation
  fails validation.
- Discovery validates provider metadata without executing the provider.
- A manifest with malformed `operations.*.authorization.resource` fails
  validation.
- A manifest with malformed `operations.*.authorization.input` fails
  validation.
- Manifest permission declarations remain requirements and are not treated as
  grants.

## Router Authorization Checks

- Provider-runtime boundary deny plus app provider allow still denies.
- Required provider allow plus app-domain provider deny denies.
- Required provider allow plus app-domain provider `needs_grant` denies and
  returns grant suggestion.
- Required provider allow plus app-domain provider `not_applicable` denies when
  the operation requires a provider.
- Provider timeout denies.
- Provider thrown error denies.
- Provider invalid JSON denies.
- Provider response that fails schema denies.
- Provider allow cannot bypass a required provider-runtime boundary denial.
- Provider allow cannot bypass missing provider-equivalent `use app:<id>` for
  non-mutating operations.
- Provider allow cannot bypass missing provider-equivalent `execute app:<id>` for
  mutating operations.
- Direct local operator execution remains break-glass only when no runtime
  principal/context exists.
- The operation referenced by `permissions.provider.operation` cannot be invoked
  directly as an ordinary app operation.
- App help/guide surfaces do not advertise the reserved provider operation as a
  normal operation.

## Request Envelope Checks

- Request includes canonical `actor`, `surface`, `session`, `executorAgent`,
  `appId`, `operation`, `resource`, selected `input`, and provider-runtime
  boundary summary.
- Request does not include raw context keys.
- Request does not include credentials or bearer tokens.
- Provider subprocess env does not include raw context keys or credential-like
  variables.
- Request does not depend on display names, phone numbers, chat titles, session
  labels, or prompt annotations for authority.
- Resource owner is canonical when ownership matters.
- Resource ids can be derived from explicit `authorization.resource` mappings
  without requiring the provider to parse display text or unrelated global state.
- Operation input defaults to an empty selected-input envelope unless the
  operation explicitly opts in to safe args/options.

## Decision Checks

- Decision is one of `allow`, `deny`, `needs_grant`, or `not_applicable`.
- Every decision has a stable `reasonCode`.
- `allow` records safe audit evidence.
- `deny` has user-safe reason and operator-safe audit detail when available.
- `needs_grant` never executes the operation.
- `needs_grant` suggestions default to temporary TTL.
- Grant suggestions do not propose wildcard/admin grants unless break-glass is
  explicit and core-approved.
- Cache TTL is bounded and included in audit when used.

## Visibility Checks

- Broad app resource list filters by provider visibility.
- Direct lookup for hidden resources returns not-found-equivalent unless caller
  has diagnostic permission.
- Autocomplete/search does not disclose hidden resource names.
- A resource visible to the app provider is still hidden when the provider
  runtime boundary denies app visibility.

## Audit Checks

- Audit includes provider id/version, app id, operation id, resource id, actor,
  surface, session, executor agent, required provider result, app-domain
  provider decision, reason code, cache hit/miss, and duration.
- Audit redacts raw context keys and credentials.
- Denial explain distinguishes required-provider denial from app-domain provider
  denial.
- Grant suggestion audit includes proposed subject/relation/object/TTL/reason
  without applying it.

## Migration Checks

- Existing app command-layer authorization can run provider dry-run without
  changing behavior.
- Dry-run records mismatches between legacy decision and provider decision.
- Enforcement can be enabled per operation.
- Removing legacy checks requires equivalent provider regression coverage.
