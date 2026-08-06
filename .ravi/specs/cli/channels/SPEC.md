---
id: cli/channels
title: "Channels config agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - channels
tags:
  - cli
  - channels
  - agent-first
  - error-envelope
  - exit-taxonomy
applies_to:
  - src/cli/commands/channels.ts
  - src/router/router-db.ts
  - src/plugins/internal/ravi-system/skills/channels/SKILL.md
  - src/cli/agent-contract.ts
owners:
  - ravi-dev
status: active
normative: true
---
# Channels config agent-first CLI contract

## Intent

Make the CONFIG surface of `ravi channels` (`list`, `show`, `create`, `set`)
reliable for agent consumers under the agent-first contract defined by
`cli/crm`: typed not-found envelopes with cheap local suggestions and compact
discovery. The process-infrastructure surface of the same domain —
`start`, `stop`, `restart`, `run`, `logs`, `probe`, `status` (PM2/runner
lifecycle) and everything in `channel-backend.ts` — is OUTSIDE this contract:
it is human/ops process management dispensada pelo ledger (MIGRACAO-LEDGER.md,
"Dispensados"), analogous to `daemon`/`service`.

## Invariants

1. With `--json`, every failure on a migrated config op MUST return the
   envelope `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?}}`.
2. Exit codes on migrated ops MUST follow the taxonomy: `0` success · `1`
   error (not-found) · `2` usage error · `3` policy.
3. `channels show` and `channels set` on an unknown config name MUST exit 1
   with `CHANNEL_NOT_FOUND` and up to 3 `suggestions` from the local channel
   config names. In THIS domain the code refers to a Ravi native channel
   CONFIG record in the router DB — not to a Slack workspace channel; the
   `slack` domain reuses the same code for that distinct remote resource, and
   the `suggestedAction` (`ravi channels list`) disambiguates.
4. `channels create` and `channels set` referencing an unknown
   `--credential-connection` MUST exit 1 with
   `CREDENTIAL_CONNECTION_NOT_FOUND` (cross-domain envelope shared with
   `cli/credentials`), with local `provider:connection` suggestions and no
   secret material, and MUST NOT write the channel config.
5. `channels create` and `channels set` are declared UNBRAKED: they write
   reversible local config rows only (create ⇄ `set enabled false`; every
   `set` key has an inverse `set`), and nothing starts or stops the runner.
6. `channels list` MUST accept `--fields a,b,c` for compact output.
7. The infra ops (`start`, `stop`, `restart`, `run`, `logs`, `probe`,
   `status`) keep their pre-existing behavior untouched.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| create | reversible local config upsert | not braked (declared) |
| set | reversible local config update (inverse `set` exists for every key) | not braked (declared) |
| start / stop / restart / run / logs / probe / status | process infrastructure (PM2 lifecycle) | fora do contrato (dispensada — ledger) |

## Official error cases

| case | code | exit |
|---|---|---|
| channel config not found | `CHANNEL_NOT_FOUND` + suggestions (config names) | 1 |
| referenced credential connection not found | `CREDENTIAL_CONNECTION_NOT_FOUND` + suggestions | 1 |

## Internal consumers

The `channels` skill (`channels-manager`) documents this contract in its
`## Contrato Do CLI` section and points infra ops at the ledger. The channel
runner itself reads configs through `router-db`, not through the CLI.

## Validation

- `bun test src/cli/commands/channels.test.ts` green (13 pre-existing tests +
  contract describes; isolated `RAVI_STATE_DIR`).
- `bun run typecheck` clean.

## Known Failure Modes

- The `channels` domain root is not yet listed in `AGENT_CONTRACT_DOMAINS`
  (`src/cli/index.ts`, out of scope for this migration lot), so commander
  parser usage errors still print plain text with exit 1 instead of the
  `USAGE_ERROR` envelope with exit 2.
- `CHANNEL_NOT_FOUND` is overloaded across domains: here it means a local
  channel CONFIG name; in the `slack` domain it means a Slack workspace
  channel. Consumers MUST disambiguate by `op`, never by code alone.
- `channels-json.test.ts` (baseline-failing since the whatsapp migration: its
  `../context.js` mock lacks `hasContext`) tests `group.ts`/`whatsapp-dm.ts`,
  not this file — do not "fix" this contract by editing that suite.
