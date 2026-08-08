---
id: cli/mail
title: "Mail agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - mail
  - gmail
tags:
  - cli
  - mail
  - gmail
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
applies_to:
  - src/cli/commands/mail.ts
  - src/cli/commands/gmail.ts
  - src/cli/agent-contract.ts
  - src/cli/registry.ts
owners:
  - ravi-dev
status: active
normative: true
---
# Mail agent-first CLI contract

## Intent

Make `ravi mail` (accounts, mailboxes, messages, outbox, threads, providers,
domains) and `ravi gmail` reliable for agent consumers under the agent-first
contract defined by `cli`: typed error envelopes, the 0/1/2/3 exit
taxonomy, a write brake on every op that produces external e-mail to real
humans, and compact discovery. Mail is the highest-blast-radius surface in the
CLI — a sent e-mail cannot be unsent — so every send path (`mail send`,
`mail reply`, `mail providers ravi-mail send`, `gmail send`) is braked.

## Invariants

1. With `--json`, every failure on a migrated op MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?}}`.
2. Exit codes MUST follow the taxonomy: `0` success · `1` error (not-found /
   provider) · `2` usage error · `3` blocked by policy (write brake).
3. `mail send`, `mail reply`, `mail providers ravi-mail send` and `gmail send`
   MUST default to dry-run and require `--execute` (always the LAST declared
   option); the dry-run MUST report `dryRun: true` and an exact metadata-only
   `plan` carrying `fromPresent`, `toCount`, `ccCount`, `bccCount`,
   `subjectChars`, `bodyChars` and `inReplyToPresent`. It MUST NOT carry raw
   addresses, subject, body, connector id or message id, and MUST NOT enqueue,
   write, or call any provider/connector. For `gmail send` the brake fires
   BEFORE connector resolution (`listConnectors`) — not just before the send
   capability.
4. Not-found failures MUST use per-resource codes: `ACCOUNT_NOT_FOUND`,
   `MAILBOX_NOT_FOUND`, `MESSAGE_NOT_FOUND`, `OUTBOX_NOT_FOUND`,
   `THREAD_NOT_FOUND` — exit 1. Accounts and mailboxes come from the cheap
   local DB, so those two carry up to 3 `suggestions` (ids/addresses/names).
   Messages, outbox rows, and threads have opaque ULID ids, so their envelopes
   omit `suggestions` and point at the listing command via `suggestedAction`.
5. `readMailMessage` throws on unknown ids; `mail messages read` and
   `mail reply` MUST map that throw to `MESSAGE_NOT_FOUND`
   (`readMailMessageForContract`), never a generic provider error.
6. The local listings (`accounts list`, `mailboxes list`, `messages list`,
   `outbox list`, `providers list`) MUST accept `--fields a,b,c` for compact
   output. Remote Console listings (`domains list`,
   `providers ravi-mail mailboxes|messages list`) keep provider-owned payload
   shapes and are not field-filtered.
7. `runMailCommand` and `runGmailCommand` wrap every command body in a legacy
   CloudAuthError catch; both MUST rethrow `ContractError` untouched so the
   registry dispatcher preserves the exit taxonomy (1/2/3) for agent callers.
8. Without `--json`, command-body error output keeps the legacy text path
   (exit 1). Parser-level usage errors use the global exit-2 `USAGE_ERROR`
   envelope with `acceptedFlags` for both `mail` and `gmail`.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| mail send | external e-mail to real humans (irreversible) | dry-run + `--execute` |
| mail reply | external e-mail to real humans (irreversible) | dry-run + `--execute` |
| mail providers ravi-mail send | direct external send through Console | dry-run + `--execute` |
| gmail send | external e-mail through connector | dry-run + `--execute` |
| accounts create / mailboxes create / domains create / providers ravi-mail mailboxes create | reversible config/projection | not braked (declared) |
| accounts sync / messages import | local ingestion, re-runnable | not braked (declared) |
| outbox retry | re-queues an already-authorized send | not braked (declared) |
| mailboxes disable / providers ravi-mail mailboxes disable | reversible pair (re-enable/create) | not braked (declared) |

## Official error cases

| case | code | exit |
|---|---|---|
| account not found | `ACCOUNT_NOT_FOUND` + suggestions | 1 |
| mailbox not found (incl. no active send mailbox) | `MAILBOX_NOT_FOUND` + suggestions or create hint | 1 |
| message not found | `MESSAGE_NOT_FOUND` + suggestedAction | 1 |
| outbox row not found | `OUTBOX_NOT_FOUND` + suggestedAction | 1 |
| thread not found | `THREAD_NOT_FOUND` + suggestedAction | 1 |
| braked send without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |

## Internal consumers

There is NO dedicated `mail` or `gmail` skill in
`src/plugins/internal/ravi-system/skills/` — this is a documented gap; this
spec is the authoritative CLI→doc surface until a skill ships, and any future
skill MUST teach `--execute` on every braked send op. The teaching sites that
exist today were updated: `.ravi/specs/mail/SPEC.md` (public surface examples
for `mail send`/`mail reply`) and `.ravi/specs/mail/local-mailbox/CHECKS.md`
(outbox check). The trigger catalog (`src/triggers/topic-catalog.ts`) only
teaches read commands (`mail messages read`), which are unbraked. Generated
artifacts (`docs/openapi.json`, `packages/*` SDKs) are regenerated by
`sdk:generate`, not edited by hand.

## Validation

- `bun test src/cli/commands/mail.test.ts` green (contract block included), no
  new failures vs the `dev` baseline.
- Live checks on the local CLI (isolated `RAVI_STATE_DIR`): `mail send --to x
  --subject s --body b --json` → exit 3, `dryRun: true`, empty outbox; with
  `--execute` → outbox row `pending`; `mail mailboxes show nope --json` →
  `MAILBOX_NOT_FOUND` + suggestions, exit 1; `mail accounts list --json
  --fields id,provider` narrows items; `gmail send` without `--execute` → exit
  3 with no connector lookup.

## Known Failure Modes

- `runMailCommand`/`runGmailCommand` wrap ALL thrown errors into
  CloudAuthError; without the `ContractError` rethrow the brake collapses into
  a generic provider error with the wrong exit code.
- `readMailMessage` throws on unknown ids instead of returning null; mapping
  only explicit null checks misses the real not-found path in `messages read`
  and `reply`.
- `gmail send` resolves the default Google connector before sending; a brake
  placed after that resolution still performs a network/DB lookup on a dry-run.
- `mail.test.ts` does not mock `../context.js`; the contract tests set
  `RAVI_SESSION_KEY` (and only that env) so `hasContext()` is true — making the
  helpers throw `ContractError` instead of `process.exit` — while
  `getScopeContext().agentId` stays undefined and keeps the local-operator
  permission path open.
- Legacy `CloudAuthError` payload errors (for example `PAYLOAD_INVALID` when a
  mailbox references an unknown account) retain their stable code, but the
  shared transport maps them to the global taxonomy (`PAYLOAD_INVALID` → `2`,
  other provider/auth failures → `1`). Contract ops still rethrow
  `ContractError` first so braked and not-found paths remain exact.
