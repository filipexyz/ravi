---
id: cli/contacts
title: "Contacts agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - contacts
tags:
  - cli
  - contacts
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
applies_to:
  - src/cli/commands/contacts.ts
  - src/cli/agent-contract.ts
  - src/cli/registry.ts
  - src/plugins/internal/ravi-system/skills/contacts/SKILL.md
owners:
  - ravi-dev
status: active
normative: true
---
# Contacts agent-first CLI contract

## Intent

Make `ravi contacts` (and its `metadata` group) reliable for agent consumers
under the agent-first contract defined by `cli/crm`: typed error envelopes, the
0/1/2/3 exit taxonomy, a write brake on the riskiest mutations, and compact
discovery. Contacts gate who can talk to the bot, so `remove`, `block` and
`merge` — the ops that delete a record, silence a live channel peer, or
irreversibly collapse two identities — are the braked ops.

## Invariants

1. With `--json`, every failure on a migrated op MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedFlags?}}`.
2. Exit codes MUST follow the taxonomy: `0` success · `1` error (not-found /
   provider) · `2` usage error · `3` blocked by policy (write brake).
3. Unknown contact refs on migrated ops MUST exit 1 with `CONTACT_NOT_FOUND`
   and up to 3 `suggestions` — and the suggestion candidates MUST come only
   from the caller-scope-filtered contact list (`filterVisibleContacts`, the
   same filter behind `contacts list`/`find`). Contacts cloaked by
   `contactScope` (own/tagged) MUST never appear as suggestions.
4. `contacts remove`, `contacts block` and `contacts merge` MUST default to
   dry-run and require `--execute`; the dry-run MUST report `dryRun: true` and
   the `plan`, and MUST NOT delete, block or merge anything.
5. `contacts backfill` keeps its historical default-dry-run flag `--apply` —
   it is the brake equivalent for that op and MUST NOT be renamed to
   `--execute`.
6. `contacts list` and `contacts find` MUST accept `--fields a,b,c` for
   compact output, applied to every listing key of the payload (`items` and
   `contacts`).
7. When invoked from an agent context (`RAVI_*` envs present), a thrown
   `ContractError` MUST preserve its exit code through the registry
   dispatcher — the brake exits 3, never a generic `Error: ...` with exit 1.
8. Unbraked writes (`add`, `allow`, `approve`, `set`, `tag`, `untag`, `link`,
   `unlink`, `note`, `metadata set`, `metadata remove`) keep their current
   immediate-write behavior and MUST be listed as unbraked in the shipped
   `contacts` skill.
9. Without `--json`, error output keeps the legacy text path (exit 1), except
   usage errors which exit 2 and teach the correct syntax inline.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| remove | destructive (deletes the contact record) | dry-run + `--execute` |
| block | destructive (silences a live channel peer) | dry-run + `--execute` |
| merge | irreversible (moves identities, deletes source) | dry-run + `--execute` |
| backfill | bulk canonical write | historical `--apply` (default dry-run, brake-equivalent) |
| add / allow / approve / set / tag / untag / link / unlink / note | reversible record edits | not braked (declared) |
| metadata set / metadata remove | reversible scoped metadata | not braked (declared) |

## Official error cases

| case | code | exit |
|---|---|---|
| contact not found | `CONTACT_NOT_FOUND` + scope-filtered suggestions | 1 |
| invalid flag/arg | `USAGE_ERROR` + acceptedFlags | 2 |
| braked write without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |

## Internal consumers

`src/plugins/internal/ravi-system/skills/contacts/SKILL.md` teaches this
surface and MUST document `--execute` on every braked op (its remove/block/
merge examples carry the flag). The `agents` skill block hint and the
`contacts pending` text hint also teach `block --execute`.
`docs/cli/overview.mdx` and `docs/guides/contacts.mdx` mirror the same syntax.
Daemon-side contact intake (runtime message flow) writes through the service
layer (`upsertContact`/`linkContactIdentity`), not through the CLI, so the
brake does not affect automatic intake.

## Validation

- `bun test src/cli/commands/contacts.test.ts` green (contract block
  included), no new failures vs the `dev` baseline.
- Live checks on the local CLI (isolated `RAVI_STATE_DIR`): `contacts get
  <bad-ref> --json` → `CONTACT_NOT_FOUND`, exit 1; `contacts list
  --no-such-flag --json` → `USAGE_ERROR`, exit 2; `contacts block <ref>
  --json` → exit 3 and the contact still allowed; with `--execute` → blocked;
  `contacts list --json --fields id,name` narrows items; brake verified with
  `RAVI_AGENT_ID` set (agent-context env) still exits 3 with the envelope.

## Known Failure Modes

- Suggestions built from the unfiltered contact table would leak contacts that
  `contactScope` cloaks as not-found; candidates must always pass through
  `filterVisibleContacts` (the `contacts list` filter).
- The contacts service layer throws `Contact not found: <ref>` (e.g.
  `addContactNote`, `setContactMetadata`) inside command try/catch blocks that
  used to flatten everything through `fail(err.message)`; without the
  `rethrowContactCommandError` mapping the envelope regresses to plain text and
  a thrown `ContractError` would be swallowed into a generic exit 1.
- `contacts get` used to report not-found as `found:false` with exit 0 and
  `contacts remove` as a soft `not_found` payload — both invisible to agent
  callers branching on exit codes; the contract now hard-fails with
  `CONTACT_NOT_FOUND`.
- `contacts.test.ts` spreads the real `../context.js`, whose `hasContext`
  reads `RAVI_*` envs; the mock MUST pin `hasContext: () => true` or the
  contract helpers call `process.exit` mid-test depending on the environment.
