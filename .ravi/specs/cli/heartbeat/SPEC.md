---
id: cli/heartbeat
title: "Heartbeat agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - heartbeat
tags:
  - cli
  - heartbeat
  - agent-first
  - error-envelope
  - exit-taxonomy
applies_to:
  - src/cli/commands/heartbeat.ts
  - src/cli/commands/heartbeat.test.ts
  - src/cli/agent-contract.ts
  - src/heartbeat
  - src/plugins/internal/ravi-system/skills/heartbeat/SKILL.md
owners:
  - ravi-dev
status: active
normative: true
---
# Heartbeat agent-first CLI contract

## Intent

Make `ravi heartbeat` reliable for agent consumers under the agent-first
contract defined by `cli`: typed error envelopes, the 0/1/2/3 exit
taxonomy, and compact discovery. This domain deliberately declares NO braked
op — the contract value here is the `AGENT_NOT_FOUND` envelope, exit
discipline and `--fields`, not `--execute`.

## Invariants

1. With `--json`, every failure on a migrated op MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedFlags?}}`.
2. Exit codes MUST follow the taxonomy: `0` success · `1` error (not-found /
   provider) · `2` usage error · `3` blocked by policy (unused in this
   domain — no braked op exists).
3. `heartbeat show`, `enable`, `disable`, `set` and `trigger` on an unknown
   agent MUST exit 1 with `AGENT_NOT_FOUND` and up to 3 `suggestions` from
   live agent ids/names.
4. `heartbeat status` (the domain's listing) MUST accept `--fields a,b,c` for
   compact output.
5. When invoked from an agent context (`RAVI_*` envs present), a thrown
   `ContractError` MUST preserve its exit code through the registry
   dispatcher.
6. Every write in this domain is declared unbraked (no `--execute` anywhere):
   `trigger` fires the agent's OWN heartbeat — a benign, frequent operational
   action that just processes `HEARTBEAT.md` and is suppressed when the agent
   answers `HEARTBEAT_OK`; `enable`/`disable` are a reversible pair; `set`
   writes reversible config properties (interval, model, account,
   active-hours). Braking any of them would put exit-3 friction inside
   routine operation without protecting anything destructive.
7. Without `--json`, error output keeps the legacy text path (exit 1), except
   usage errors which exit 2 and teach the correct syntax inline.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| trigger | fires the agent's own heartbeat (benign, frequent, HEARTBEAT_OK-suppressed) | not braked (declared) |
| enable / disable | reversible pair | not braked (declared) |
| set | reversible config property write | not braked (declared) |

## Official error cases

| case | code | exit |
|---|---|---|
| agent not found | `AGENT_NOT_FOUND` + suggestions | 1 |
| invalid flag/arg | `USAGE_ERROR` + acceptedFlags | 2 |
| invalid `set` property/value | legacy `fail` text (exit 1) | 1 |

## Internal consumers

`src/plugins/internal/ravi-system/skills/heartbeat/SKILL.md` teaches this
surface and MUST state that the domain has no braked op (no `--execute`
anywhere) plus the envelope/exit/`--fields` contract. No other internal doc
teaches heartbeat mutations.

## Validation

- `bun test src/cli/commands/heartbeat.test.ts` green (contract block
  included).
- Live checks on the local CLI (isolated `RAVI_STATE_DIR`): `heartbeat show
  <bad-id> --json` → `AGENT_NOT_FOUND`, exit 1 + suggestions; `heartbeat
  status --no-such-flag --json` → `USAGE_ERROR`, exit 2; `heartbeat status
  --json --fields agent,heartbeat` narrows items; `heartbeat trigger <id>`
  fires (or skips on missing/empty `HEARTBEAT.md`) without any `--execute`.

## Known Failure Modes

- `heartbeat.test.ts` mocks `../context.js` with an object literal (no spread
  of the real module); the mock MUST export `hasContext: () => true` or the
  contract helpers call `process.exit` inside tests.
- `heartbeat trigger` on an agent whose workspace lacks `HEARTBEAT.md` is a
  success (`status: "skipped"`, exit 0), not an error — do not map it to the
  envelope.
