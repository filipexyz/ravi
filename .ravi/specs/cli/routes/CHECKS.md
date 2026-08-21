# Routes read-only agent-first CLI contract / CHECKS

## Contract checks

- The top-level `RoutesCommands` methods MUST remain read-only and MUST NOT
  invoke any write primitive or emit config-change events.
- `routes list`, `routes show`, and `routes explain` MUST declare
  `audit:"none"`. Real CLI processes MUST run without `RAVI_NO_AUDIT` or
  `RAVI_SUPPRESS_AUDIT_EVENTS` and prove that a listening NATS trap receives no
  connection or bytes.
- An absent database MUST remain absent after the real `routes list` process.
  Current and minimal legacy databases MUST be opened read-only without schema
  migration; logical rows and durable DB/WAL bytes MUST remain unchanged.
- An existing table without its required columns MUST produce exit 1
  `ROUTES_SCHEMA_UNSUPPORTED`, naming only the table and missing columns. It
  MUST NOT be represented as an empty route configuration or change durable
  state.
- Human list rendering MUST use only the captured route snapshot and MUST NOT
  initialize or query the contact store for presentation-only status.
- A committed WAL route MUST remain visible while another connection is open.
  Do not use SQLite `immutable=1`: the daemon may write concurrently.
- `group:X` MUST find and simulate one route stored as `X@g.us`, and the
  reverse representation MUST share the router canonicalizer.
- A concrete `phone:+X` input MUST normalize to the digits consumed by routing
  and MUST NOT receive `skipped_broad_pattern`.
- A glob MUST remain non-concrete and MUST explain why simulation was skipped.
- More than one equivalent stored pattern without an exact literal match MUST
  produce `ROUTE_PATTERN_AMBIGUOUS` before simulation.
- Unknown `--fields` MUST produce exit 2 `USAGE_ERROR` with the stable
  `acceptedFields`, including on an empty list.
- Invalid or above-maximum pagination MUST retain its specific cause; valid
  pagination MUST produce a correct deterministic `nextCommand`.
- Unknown `--channel` MUST produce exit 2 `USAGE_ERROR` with
  `acceptedChannels` before `matchRoute` runs.
- Every explain payload MUST disclose persisted-config origin, freshness
  semantics, and `daemonObserved:false`; human output MUST make the same
  distinction.
- Unknown instance and literal route lookups MUST preserve typed not-found
  behavior and stable suggestions.
- `ROUTE_NOT_FOUND` suggestions MUST come from the captured
  `ReadOnlyRoutesSnapshot`. A real missing-route lookup on a minimal legacy
  database MUST preserve DB and WAL bytes; only SQLite `-shm` coordination is
  exempt.
- If channel names/providers/routes contain case-colliding variants, a
  non-exact spelling MUST produce exit 2 `ROUTE_CHANNEL_AMBIGUOUS` before the
  resolver runs. An exact spelling MUST reach the resolver unchanged.
- Two unchanged executions of list, show, and explain MUST serialize equally
  and leave route, instance, contact, pending, session, settings, channel, and
  event state unchanged.
- `items` and `routes` MUST remain equivalent compatibility aliases.
- Public return schemas MUST reject undeclared detail fields and empty compact
  route items while preserving typed projections in generated clients.
- TypeScript and JSON Schema/OpenAPI MUST encode compact route items as a union
  requiring at least one accepted field. Swift MUST emit concrete named models
  for route items, details, origin, resolution, live effect, runtime target and
  tags, including concrete optional types through nullable unions.

## Required native checks

```bash
bun test src/router/routes-readonly.test.ts src/router/router.test.ts src/router/resolver.test.ts src/cli/commands/routes.test.ts
bun run typecheck
bun run build
bunx biome check src/router/routes-readonly.ts src/router/routes-readonly.test.ts src/router/config.ts src/router/resolver.ts src/router/resolver.test.ts src/router/router.test.ts src/router/index.ts src/cli/runtime-target.ts src/cli/commands/instances.ts src/cli/commands/routes.test.ts src/cli/commands/operational-return-schemas.ts
```

When the return contracts are strengthened, the same change MUST remove
`routes.list`, `routes.show`, and `routes.explain` from
`src/sdk/client-codegen/return-schema-quality-baseline.ts`; `bun run test:sdk`
is the executable inventory check.

Promotion additionally requires independent review and green Linux CI on the
exact commit. Local success alone does not authorize commit, push, merge, or
deployment.

## Compact nullable projection checks

- Native CLI tests MUST cover empty `--fields`, an interior empty token, and a
  trailing comma as exit 2 `USAGE_ERROR` with stable `acceptedFields`.
- Runtime and Zod tests MUST accept an explicitly selected absent `policy` as
  `{ "policy": null }` and MUST continue to reject `{}`.
- A call without `--fields` MUST omit absent optional route fields.
- TypeScript and OpenAPI MUST publish the selected `policy` variant as required
  and nullable. Swift generation MUST retain present-null key identity and its
  compiler-backed test MUST prove `{"policy":null}` round-trips unchanged.
