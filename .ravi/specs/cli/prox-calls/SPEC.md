---
id: cli/prox-calls
title: "Prox Calls agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - prox-calls
tags:
  - cli
  - prox-calls
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
applies_to:
  - src/cli/commands/prox-calls.ts
  - src/cli/agent-contract.ts
  - src/plugins/internal/ravi-system/skills/prox-calls/SKILL.md
owners:
  - ravi-dev
status: active
normative: true
---
## Intent

Make `ravi prox calls` (and its `profiles`, `voice-agents`, `tools` groups)
reliable for agent consumers under the agent-first contract defined by
`cli`. The riskiest op in the whole surface is `request` — it schedules a
REAL phone call to a real person through a live voice provider — so it is the
primary braked op. `cancel` is deliberately unbraked (damage stop).

## Invariants

1. With `--json`, every failure on a migrated op MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?}}`.
2. Exit codes MUST follow the taxonomy: `0` success · `1` error (not-found) ·
   `2` usage error · `3` blocked by policy (write brake).
3. `prox calls request` MUST default to dry-run and require `--execute`; the
   dry-run MUST report `dryRun: true` and a plan with profile/provider ids,
   `personIdPresent`, phone/reason presence, priority, dynamic-variable count,
   control booleans and `providerMode` stub/live. It MUST NOT expose the person
   id, phone, reason or dynamic-variable keys/values, and MUST NOT call
   `submitCallRequest`.
4. `request` MUST validate the profile BEFORE the brake: an unknown profile is
   exit 1 with `CALL_PROFILE_NOT_FOUND`, never a wasted dry-run.
5. `prox calls cancel` MUST stay unbraked: it is a damage stop for a
   pending/imminent real call (workflows-cancel precedent).
6. Not-found envelopes per resource: `CALL_PROFILE_NOT_FOUND`,
   `CALL_REQUEST_NOT_FOUND`, `TRANSCRIPT_NOT_FOUND`, `VOICE_AGENT_NOT_FOUND`,
   `CALL_TOOL_NOT_FOUND`, `TOOL_BINDING_NOT_FOUND` — suggestions come from the
   LOCAL calls DB (profiles/voice-agents/tools). Call requests have no local
   list command, so that envelope carries only `suggestedAction`.
7. `profiles list`, `voice-agents list` and `tools list` MUST accept
   `--fields a,b,c`; the projected items MUST be identical in `items` and the
   legacy alias key (`profiles`/`voice_agents`/`tools`).
8. Pre-existing `--dry-run` flags are the documented write-brake EQUIVALENTS
   and MUST NOT be renamed: `voice-agents sync` (dry-run by DEFAULT; live push
   still reported `would_push`/`skipped`) and `tools run --dry-run` (live
   execution additionally hard-blocked with `execution_not_implemented`).
9. `profiles configure` MUST require `--execute` only when the effective
   ElevenLabs profile, provider agent and changed fields cause a real provider
   synchronization. The dry-run MUST precede both local persistence and HTTP.
   `--skip-provider-sync` and local-only updates remain immediate.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| request | schedules a REAL phone call (external, human-facing) | dry-run + `--execute` |
| cancel | damage stop for a real call | not braked (declared) |
| profiles configure, local-only / `--skip-provider-sync` | reversible local config | not braked |
| profiles configure with effective ElevenLabs sync | external provider mutation | conditional dry-run + `--execute` |
| voice-agents create/configure/bind-tool/unbind-tool | reversible local config | not braked (declared) |
| tools create/configure/bind/unbind | reversible local config | not braked (declared) |
| voice-agents sync | provider push | `--dry-run` default (equivalent, flag kept) |
| tools run | tool execution | `--dry-run` (equivalent) + live hard-block |

## Official error cases

| case | code | exit |
|---|---|---|
| profile not found | `CALL_PROFILE_NOT_FOUND` + suggestions | 1 |
| call request not found | `CALL_REQUEST_NOT_FOUND` + suggestedAction | 1 |
| transcript missing | `TRANSCRIPT_NOT_FOUND` (retryable) | 1 |
| voice agent not found | `VOICE_AGENT_NOT_FOUND` + suggestions | 1 |
| tool not found | `CALL_TOOL_NOT_FOUND` + suggestions | 1 |
| binding not found | `TOOL_BINDING_NOT_FOUND` + suggestedAction | 1 |
| braked write without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |

## Internal consumers

`src/plugins/internal/ravi-system/skills/prox-calls/SKILL.md` teaches this
surface: its `## Contrato Do CLI` section documents the brake on `request`
(examples carry `--execute`), the unbraked/equivalent ops with rationale, and
the `--fields` compact mode. `request`, transcript sync and configuration
operations that can persist or call providers are authorized as `mutate`;
exact legacy read grants are migrated to matching mutate grants.

## Validation

- `bun test src/cli/commands/prox-calls.test.ts` green (contract block
  included), real sqlite in an isolated `RAVI_STATE_DIR`.
- Live checks: `prox calls request ... --json` → exit 3 and no `call_requests`
  row; with `--execute` (stub provider) → row persisted; `prox calls show
  cr_nope --json` → `CALL_REQUEST_NOT_FOUND`, exit 1; `profiles list --fields
  id,name --json` narrows items.

## Known Failure Modes

- Skipping the profile-existence check before the brake makes agents burn an
  exit-3 round-trip on a typoed profile and only learn about the bad id on the
  `--execute` attempt.
- The human-readable table printers read the RAW page items; feeding them the
  `--fields`-projected rows crashes on missing columns — projection applies to
  the JSON payload only.
