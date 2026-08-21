---
id: cli/self
title: "Self agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - self
tags:
  - cli
  - self
  - agent-first
  - read-only
  - compact-mode
applies_to:
  - src/cli/commands/self.ts
  - src/cli/context.ts
  - src/cli/tools-export.ts
  - src/cli/agent-contract.ts
  - src/cli/commands/operational-return-schemas.ts
  - src/runtime/runtime-operational-context.ts
owners:
  - ravi-dev
status: active
normative: true
---

## Intent

Provide one read-only orientation facade for `whoami`, `context`, `chat`,
`route`, `recent`, `permissions`, `knowledge` and `explain`. Root operational
help and adjacent `context whoami/capabilities` views MUST use the same
registered context facts whenever one is resolved.

## Invariants

1. Every `self` op (`whoami`, `context`, `chat`, `route`, `recent`,
   `permissions`, `knowledge`, `explain`) MUST remain read-only: no DB writes,
   no NATS mutations, no context touch (`resolveRuntimeContextOrThrow` runs
   with `touch: false, readOnly: true`).
2. NO `self` op may gain a write brake (`--execute`) — declared: there is
   nothing to brake in a read-only domain.
3. There is no per-entity lookup by user-supplied id, so no `*_NOT_FOUND`
   envelope applies. Missing context MUST return `SELF_CONTEXT_REQUIRED`;
   failed resolution MUST return `SELF_CONTEXT_UNAVAILABLE`, both exit 1 with
   a public cause and corrective action.
4. `self context` MUST accept `--fields a,b,c` against a stable public field
   set. Unknown names MUST use the shared `USAGE_ERROR` exit 2 contract and
   include `acceptedFields`. With `--fields`, output is projected JSON even
   without `--json`, and the returned payload matches it.
5. Sensitive values MUST stay protected: the context key is never printed;
   metadata keys matching key/token/secret/password/credential/authorization/
   cookie/header are redacted recursively; secret-shaped values are redacted
   even when stored under an innocuous key.
6. Recent-message inspection MUST stay bounded by `--limit` (1..100).
7. `--depth` and `--limit` validation MUST use public `ARG_INVALID` failures
   that preserve the offending value and corrective action in every transport.
8. Identity values come from the resolved context-registry record. Root help
   MUST prefer that record and MUST NOT display `RAVI_*` values. If no record
   exists, identity and capabilities MUST be `unavailable`, not inferred from
   ambient env or represented as an authoritative empty set.
9. Actor precedence is context metadata, declared actor env, then recent
   non-agent message metadata. Env-derived actor data MUST be `partial`, carry
   `source: environment` and `trust: unverified`.
10. The environment contract MUST name every actor env variable, list
    precedence, state that values may appear only as resolved actor data, and
    state that `RAVI_AGENT_ID`, `RAVI_CHANNEL`, `RAVI_ACCOUNT_ID` and
    `RAVI_CHAT_ID` are not SELF identity fallbacks.
11. Every operation MUST own a concrete return schema. No SELF command may
    remain in the weak public return-schema baseline.
12. Human `self context` output MUST render actor, chat and route once each.

## Environment contract

- Context resolution reads a resolved CLI context first. That context may come
  from `RAVI_CONTEXT_KEY`, the default credential, or tool/gateway binding. A
  direct `RAVI_CONTEXT_KEY` lookup is the final context fallback.
- An explicit `RAVI_CONTEXT_KEY` is binding: if it is unknown, expired or
  revoked, resolution MUST fail closed and MUST NOT substitute the default
  credential or legacy environment identity.
- Tool execution MUST receive a registered context bound to that in-process
  invocation. A tool MUST NOT inherit authority from ambient process env or
  the operator's default credential.
- Actor env names are `RAVI_ACTOR_TYPE`, `RAVI_CONTACT_ID`,
  `RAVI_ACTOR_AGENT_ID`, `RAVI_PLATFORM_IDENTITY_ID`,
  `RAVI_CANONICAL_CHAT_ID`, `RAVI_RAW_SENDER_ID`,
  `RAVI_NORMALIZED_SENDER_ID`, `RAVI_SENDER_ID` and `RAVI_SENDER_PHONE`.
- Help and the environment contract expose names, never values. Resolved actor
  identifiers may appear in actor data and MUST be marked unverified when env
  supplied them.

## Degradation and exit taxonomy

| Result | Meaning | Exit |
|---|---|---:|
| `ok` | source resolved | 0 |
| `partial` | usable but incomplete or weakly sourced | 0 |
| `missing` | source absent in this context | 0 |
| `unavailable` | subsystem does not exist or cannot be consulted | 0 |
| public operational failure | context missing/unresolvable or invalid value | 1 |
| `USAGE_ERROR` | parser error or unknown `--fields` | 2 |

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| whoami / context / chat / route / recent / permissions / knowledge / explain | read-only | n/a (declared: no brakes in this domain) |

## Official error cases

| case | code | exit |
|---|---|---|
| missing context | `SELF_CONTEXT_REQUIRED` | 1 |
| unresolvable context | `SELF_CONTEXT_UNAVAILABLE` | 1 |
| invalid depth/limit | `ARG_INVALID` | 1 |
| unknown projected field | `USAGE_ERROR` + `acceptedFields` | 2 |

## Internal consumers

There is no shipped skill for SELF by design. Agents discover the contract in
group help, `nextReads`, `explain`, the command manifest and concrete return
schemas. A future skill MUST reference these surfaces rather than duplicate
their policy.

## Validation

- `bun test src/cli/commands/self.test.ts` proves each operation, typed errors,
  actor-source precedence, schemas, single-render human output and zero-write
  structure.
- `bun test src/runtime/runtime-operational-context.test.ts` proves root
  registry precedence, labeled legacy fallback and honest capabilities.
- `bun test src/sdk/client-codegen/return-schema-coverage.test.ts` proves all
  eight SELF schemas are concrete.

## Known Failure Modes

- Full packets are intentionally larger; callers SHOULD start with `whoami` or
  `context --fields`.
- Runtime-bound chat/session/route success paths require a live fixture for
  deployment evidence; typed missing/partial paths remain valid without it.
- Env actor identifiers are operational identity data, not secrets. They may
  appear in actor output, but the environment declaration never prints values.

## Security addendum: trusted context and conjunctive authority

This addendum extends the earlier context-resolution and error tables. An
inline tool or gateway context is a transport claim, not a source of truth.
Before returning any SELF payload, Ravi MUST resolve its context key again from
the trusted registry with `touch: false, readOnly: true`. Unknown, expired and
revoked records MUST fail as `SELF_CONTEXT_NOT_FOUND`,
`SELF_CONTEXT_EXPIRED` and `SELF_CONTEXT_REVOKED`. A material difference
between the inline claim and the registered record MUST fail as
`SELF_CONTEXT_DIVERGENT`.

When related operational records exist, authority is conjunctive. Context,
session, chat binding, chat, route and runtime provider MUST agree on the same
agent/session/runtime before SELF exposes their data. Any contradiction MUST
fail as `SELF_AUTHORITY_DIVERGENT`, identify only the failed relation, and MUST
NOT include the foreign record, agent working directory or other protected
data. Missing optional data may still use the documented degraded section
statuses when no contradictory ownership fact exists.

These checks apply equally to direct CLI, local tools and gateway dispatch.
Validation MUST NOT refresh TTL, `lastUsedAt`, schema, journal mode or any
durable state.

The tool boundary is conjunctive with the registry check. `self_*` tools MUST
first have an invocation-bound context; ambient `RAVI_CONTEXT_KEY`, default
credentials and legacy `RAVI_*` values are not tool authority. A missing bound
context MUST fail with `TOOL_CONTEXT_REQUIRED` before command authorization or
SELF data access.
