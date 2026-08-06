---
id: cli/cron
title: "Cron agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - cron
tags:
  - cli
  - cron
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
applies_to:
  - src/cli/commands/cron.ts
  - src/cli/agent-contract.ts
  - src/plugins/internal/ravi-system/skills/cron/SKILL.md
owners:
  - ravi-dev
status: active
normative: true
---
# Cron agent-first CLI contract

## Intent

Make `ravi cron` reliable for agent consumers under the agent-first contract
defined by `cli/crm`: typed error envelopes, the 0/1/2/3 exit taxonomy, a write
brake on the riskiest mutations, and compact discovery. `cron run` fires the
REAL job right now, outside its schedule — agent execution (or a shell command)
with real side effects — so it is braked together with the destructive
`cron rm`.

## Invariants

1. With `--json`, every failure on a migrated op MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedFlags?}}`.
2. Exit codes MUST follow the taxonomy: `0` success · `1` error (not-found) ·
   `2` usage error · `3` blocked by policy (write brake).
3. Every op that resolves a job by id (`show`, `enable`, `disable`, `set`,
   `run`, `rm`) MUST exit 1 with `CRON_JOB_NOT_FOUND` and up to 3 `suggestions`
   built from job ids/names that pass the same REBAC visibility filter as
   `cron list` (access-denied stays folded into not-found, as before).
4. `cron rm` and `cron run` MUST default to dry-run and require `--execute`;
   the dry-run MUST report `dryRun: true` and the `plan`, and MUST NOT delete
   the job or emit `ravi.cron.trigger`. The `cron run` plan MUST show the
   resolved job and the message (agent jobs) or shell command (shell jobs) that
   would fire.
5. `cron list` MUST accept `--fields a,b,c` for compact output (applied to both
   `items` and `jobs`).
6. When invoked from an agent context (`RAVI_*` envs present), a thrown
   `ContractError` MUST preserve its exit code through the registry dispatcher —
   the brake exits 3, never a generic `Error: ...` with exit 1.
7. Unbraked writes (`add`, `set`, `enable`, `disable`) keep their current
   immediate-write behavior and MUST be listed as unbraked in the shipped
   `cron` skill.
8. Without `--json`, error output keeps the legacy text path (exit 1), except
   usage errors which exit 2.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| rm | destructive (schedule + config deleted) | dry-run + `--execute` |
| run | fires the REAL job now, outside the schedule (agent execution / shell) | dry-run + `--execute` |
| add / set / enable / disable | reversible config (inverse command exists) | not braked (declared) |

## Official error cases

| case | code | exit |
|---|---|---|
| job not found | `CRON_JOB_NOT_FOUND` + suggestions | 1 |
| invalid flag/arg | `USAGE_ERROR` + acceptedFlags | 2 |
| braked write without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |

## Internal consumers

`src/plugins/internal/ravi-system/skills/cron/SKILL.md` teaches this surface and
MUST document `--execute` on `cron run`/`cron rm`. The docs pages
(`docs/cli/overview.mdx`, `docs/features/overview.mdx`,
`docs/guides/cron-jobs.mdx`) teach the same flag. `AGENTS.md` still lists the
bare `ravi cron run <id>` / `ravi cron rm <id>` forms; that root instruction
file is managed separately from this wave. The daemon-side cron runner
(`src/cron/runner.ts`) executes jobs through the service layer, not through the
CLI, so the brake never affects scheduled firings.

## Validation

- `bun test src/cli/commands/cron-commands.test.ts` green (contract block
  included), no new failures vs the `dev` baseline.
- Live checks on the local CLI (isolated `RAVI_STATE_DIR`): `cron show <bad-id>
  --json` → `CRON_JOB_NOT_FOUND`, exit 1; `cron rm <id> --json` → exit 3 and
  the job still listed; with `--execute` → deleted; `cron run <id> --json` →
  exit 3 and no `ravi.cron.trigger` emitted; with `--execute` → triggered;
  `cron list --json --fields id,name` narrows items.

## Known Failure Modes

- The `cron run` brake must sit BEFORE the legacy `Triggering job:` text log
  and before `nats.emit("ravi.cron.trigger")`; placing it later logs a
  misleading "triggering" line (or fires the job) during a dry-run.
- `cron-commands.test.ts` mocks `../context.js` without spreading the real
  module; the mock MUST export `hasContext` or the contract helpers crash in
  tests (`hasContext is not a function`).
- `--execute` MUST stay the LAST `@Option` parameter of `run`/`rm`; inserting
  options after it silently shifts positional test call sites.
