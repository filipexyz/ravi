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
  - src/cli/agent-contract.ts
owners:
  - ravi-dev
status: active
normative: true
---
# Self agent-first CLI contract

## Intent

Keep `ravi self` a purely read-only orientation surface under the agent-first
contract defined by `cli/crm`. The domain answers "who am I, in which session,
bound to which chat/route, with which capabilities" — it never writes, so the
contract here is compact discovery, not brakes.

## Invariants

1. Every `self` op (`whoami`, `context`, `chat`, `route`, `recent`,
   `permissions`, `knowledge`, `explain`) MUST remain read-only: no DB writes,
   no NATS mutations, no context touch (`resolveRuntimeContextOrThrow` runs
   with `touch: false, readOnly: true`).
2. NO `self` op may gain a write brake (`--execute`) — declared: there is
   nothing to brake in a read-only domain.
3. There is no per-entity lookup by user-supplied id, so no `*_NOT_FOUND`
   envelope applies — declared. Missing context keeps the existing clear
   failure (`Missing RAVI_CONTEXT_KEY` / resolution error, exit 1).
4. `self context` MUST accept `--fields a,b,c` projecting the top-level packet
   sections (e.g. `identity,session,actor`); with `--fields`, output is the
   projected JSON even without `--json`, and the returned payload matches it.
5. Sensitive values MUST stay protected: the context key is never printed and
   metadata keys matching key/token/secret/password/credential are redacted.
6. Recent-message inspection MUST stay bounded by `--limit` (1..100).

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| whoami / context / chat / route / recent / permissions / knowledge / explain | read-only | n/a (declared: no brakes in this domain) |

## Official error cases

| case | code | exit |
|---|---|---|
| missing/unresolvable context | legacy text failure | 1 |

## Internal consumers

There is NO shipped skill for the `self` domain (gap registered by the CLI
migration): agents learn it from `nextReads` hints inside the payloads and
from AGENTS.md-adjacent docs. When a skill is created it MUST teach
`self context --fields` as the compact entrypoint.

## Validation

- `bun test src/cli/commands/self.test.ts` green (contract block included).
- Live checks: `ravi self context --fields identity,session --json` returns
  only the requested sections; `ravi self context --json` returns the full
  packet; no `self` op accepts `--execute`.

## Known Failure Modes

- The self packet is the largest read payload in the CLI; without `--fields`
  agents drag the whole packet (recent messages, capabilities, explain steps)
  into context on every orientation call.
- `self.test.ts` mocks `../context.js` by spreading the real module; the mock
  MUST override `hasContext` so future contract helpers never `process.exit`
  inside tests.
