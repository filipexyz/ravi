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
taxonomy, risk-proportional confirmation, and compact discovery.

## Invariants

1. With `--json`, every failure on a migrated op MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedFlags?}}`.
2. Exit codes MUST follow the taxonomy: `0` success · `1` error (not-found /
   provider) · `2` usage error · `3` blocked by policy.
3. `heartbeat show`, `enable`, `disable`, `set` and `trigger` on an unknown
   agent MUST exit 1 with `AGENT_NOT_FOUND` and up to 3 `suggestions` from
   live agent ids/names.
4. `heartbeat status` (the domain's listing) MUST accept `--fields a,b,c` for
   compact output.
5. When invoked from an agent context (`RAVI_*` envs present), a thrown
   `ContractError` MUST preserve its exit code through the registry
   dispatcher.
6. `enable`/`disable` and `set` remain immediate reversible configuration
   writes. `trigger` returns `skipped` without confirmation when no work file
   exists or it is empty; when work exists it MUST dry-run before queueing the
   agent prompt and require `--execute`.
7. Without `--json`, error output keeps the legacy text path (exit 1), except
   usage errors which exit 2 and teach the correct syntax inline.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| trigger | queues an agent run when HEARTBEAT.md contains work | dry-run + `--execute` |
| enable / disable | reversible pair | not braked (declared) |
| set | reversible config property write | not braked (declared) |

## Official error cases

| case | code | exit |
|---|---|---|
| agent not found | `AGENT_NOT_FOUND` + suggestions | 1 |
| invalid flag/arg | `USAGE_ERROR` + acceptedFlags | 2 |
| invalid `set` property/value | `COMMAND_FAILED` in JSON; concise text otherwise | 1 |

## Internal consumers

`src/plugins/internal/ravi-system/skills/heartbeat/SKILL.md` teaches this
surface and MUST show `--execute` for a trigger that queues work, plus the
envelope/exit/`--fields` contract. No other internal doc teaches heartbeat
mutations.

## Validation

- `bun test src/cli/commands/heartbeat.test.ts` green (contract block
  included).
- Live checks on the local CLI (isolated `RAVI_STATE_DIR`): `heartbeat show
  <bad-id> --json` → `AGENT_NOT_FOUND`, exit 1 + suggestions; `heartbeat
  status --no-such-flag --json` → `USAGE_ERROR`, exit 2; `heartbeat status
  --json --fields agent,heartbeat` narrows items; `heartbeat trigger <id>`
  skips when the file is missing/empty, otherwise exits 3 before queueing;
  adding `--execute` publishes the prompt.

## Known Failure Modes

- `heartbeat.test.ts` mocks `../context.js` with an object literal (no spread
  of the real module); the mock MUST export `hasContext: () => true` or the
  contract helpers call `process.exit` inside tests.
- `heartbeat trigger` on an agent whose workspace lacks `HEARTBEAT.md` is a
  success (`status: "skipped"`, exit 0), not an error — do not map it to the
  envelope.
