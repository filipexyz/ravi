---
id: cli/routes
title: "Routes read-only agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - routes
tags:
  - cli
  - routes
  - agent-first
  - read-only
  - config-simulation
applies_to:
  - src/cli/commands/instances.ts
  - src/cli/commands/operational-return-schemas.ts
  - src/cli/runtime-target.ts
  - src/router/config.ts
  - src/router/resolver.ts
  - src/router/routes-readonly.ts
  - src/plugins/internal/ravi-system/skills/routes/SKILL.md
owners:
  - ravi-dev
status: draft
normative: true
---
## Intent

Make `ravi routes list|show|explain` a deterministic, read-only facade for
discovering persisted route configuration. `explain` may simulate resolution
from the config database, but it never claims to inspect the daemon's in-memory
router.

## Invariants

1. The top-level `routes` group exposes only `list`, `show`, and `explain`; all
   three MUST remain `@CommandAccess kind:"read"` and MUST NOT call a route,
   session, channel, instance, setting, contact, or event write primitive.
2. `routes list` MUST use the shared pagination contract. Invalid, fractional,
   negative, or above-maximum values MUST produce `USAGE_ERROR` with the real
   cause. A successful page MUST expose total, returned count, offset, limit,
   `hasMore`, and a deterministic `nextCommand`.
3. `routes list --fields` MUST accept only `id`, `accountId`, `pattern`,
   `agent`, `priority`, `policy`, `session`, `channel`, `dmScope`, and `tags`.
   Unknown fields MUST produce `USAGE_ERROR` with `acceptedFields`, including
   when the result set is empty.
4. The duplicated `items` and `routes` arrays MUST remain equivalent for
   compatibility. New consumers SHOULD read `items`.
5. `routes show <instance> <pattern>` MUST preserve literal stored-pattern
   identity. Unknown instances and routes MUST use `INSTANCE_NOT_FOUND` and
   `ROUTE_NOT_FOUND` with deterministic suggestions.
6. `routes explain` MUST normalize concrete equivalents through the same pure
   canonicalizer used by the router. This includes `group:X` and `X@g.us`, and
   concrete phone forms such as digits and `phone:+X`. Globs MUST NOT be
   treated as one concrete target.
7. An exact stored pattern wins over equivalent lookup. If more than one stored
   pattern is equivalent and none is an exact literal match, explain MUST fail
   closed with `ROUTE_PATTERN_AMBIGUOUS`; it MUST NOT choose by ordering.
8. A supplied `--channel` MUST resolve case-insensitively against configured
   channel names/providers, instance channels, or channels already used by
   routes. Unknown values MUST produce exit 2 `USAGE_ERROR` with
   `acceptedChannels` before simulation.
9. Every explain result MUST carry `origin.kind=config_simulation`,
   `source=router-config-db`, `freshness=persisted-at-read-time`, and
   `daemonObserved=false`. Human output MUST use “config simulation” and state
   that daemon state was not observed.
10. Explain output MUST be deterministic for unchanged persisted inputs. It
    MUST NOT add a wall-clock timestamp that could masquerade as config
    freshness or make equal reads differ.
11. The facade MUST open an existing SQLite database with
    `readonly:true/create:false`, MUST return an empty list without creating a
    missing database, and MUST NOT initialize schema, migrate tables, enable
    WAL, or alter logical rows. The SQLite `-shm` coordination index is not
    durable route state and MAY be updated by a concurrency-safe read.
12. Route `channel` MUST survive both the read-only snapshot and the live
    `loadRouterConfig` projection; explain MUST simulate the same channel
    restriction used by runtime routing.
13. If a persisted table used by the snapshot exists but lacks a required
    column, the facade MUST fail closed with `ROUTES_SCHEMA_UNSUPPORTED`. It
    MUST identify only the affected table and missing column names, MUST NOT
    report an empty configuration, and MUST NOT migrate or otherwise change
    durable state.
14. All three facade commands MUST declare `audit:"none"`. A normal CLI
    process, without global audit-suppression variables, MUST NOT publish an
    audit event or open a NATS connection for either success or typed failure.
15. Every facade failure path MUST continue from the one snapshot captured for
    that invocation. In particular, `ROUTE_NOT_FOUND` suggestions MUST NOT call
    the mutable router initializer or reopen the database by pathname.
16. If configured channel values contain multiple spellings that compare equal
    without case, an exact spelling MAY proceed. A non-exact spelling MUST fail
    with exit 2 `ROUTE_CHANNEL_AMBIGUOUS` and list the exact candidates; the
    facade MUST NOT pick one by ordering.
17. Compact route items MUST remain non-empty in runtime validation and in the
    generated TypeScript, JSON Schema/OpenAPI, and Swift contracts. Route
    detail, origin, resolution, live effect, runtime target, and tag shapes MUST
    remain concrete generated models; nullable concrete models MUST NOT degrade
    to `RaviJSON`.

## Operations

| operation | effect | terminal success | typed failures |
|---|---|---|---|
| `routes list [instance]` | none | page + stable projection | `INSTANCE_NOT_FOUND`, `USAGE_ERROR`, `ROUTES_SCHEMA_UNSUPPORTED` |
| `routes show <instance> <pattern>` | none | literal route + tags | `INSTANCE_NOT_FOUND`, `ROUTE_NOT_FOUND`, `ROUTES_SCHEMA_UNSUPPORTED` |
| `routes explain <instance> <pattern>` | none | config lookup + honest simulation | `INSTANCE_NOT_FOUND`, `USAGE_ERROR`, `ROUTE_PATTERN_AMBIGUOUS`, `ROUTE_CHANNEL_AMBIGUOUS`, `ROUTES_SCHEMA_UNSUPPORTED` |

## Compatibility boundary

The neighboring `ravi instances routes` group still owns route mutations and
is outside this contract. This facade does not add brakes to, proxy, or invoke
those operations. `show` keeps literal lookup, while `explain` alone gains
equivalent-format resolution.

## Promotion status

This spec remains `draft` until the exact candidate receives independent
review and green Linux CI. Local native tests and build checks are necessary
evidence, not authorization to merge or deploy.

## Compact projection amendment

An explicitly supplied `--fields` value MUST reject an empty value, an empty
token between commas, and a trailing comma with exit 2 `USAGE_ERROR` and the
stable `acceptedFields` set. If a selected optional route field is absent from
storage, the compact JSON item and every generated contract MUST preserve that
selected key with value `null`. Without `--fields`, absent optional fields MUST
remain omitted.

Swift generated models MUST preserve selected nullable key presence across a
decode/encode round-trip. In particular, `{"policy":null}` MUST re-encode as
`{"policy":null}` and MUST NOT become `{}`. Empty compact items remain invalid.
