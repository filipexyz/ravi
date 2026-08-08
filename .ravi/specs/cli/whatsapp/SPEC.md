---
id: cli/whatsapp
title: "WhatsApp agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - whatsapp
tags:
  - cli
  - whatsapp
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
applies_to:
  - src/cli/commands/group.ts
  - src/cli/commands/whatsapp-dm.ts
  - src/cli/agent-contract.ts
  - src/cli/registry.ts
  - src/plugins/internal/ravi-system/skills/whatsapp/SKILL.md
owners:
  - ravi-dev
status: active
normative: true
---
## Intent

Make `ravi whatsapp group` and `ravi whatsapp dm` reliable for agent consumers
under the agent-first contract defined by `cli`: typed error envelopes, the
0/1/2/3 exit taxonomy, a write brake on every external mutation, and compact
discovery. This is the highest external-risk CLI domain: its mutations act on
REAL WhatsApp groups and people — a wrong send, remove or leave is socially
irreversible — so the brake covers the whole mutation surface, not just a
subset.

## Invariants

1. **No external mutation executes without `--execute`.** Every op that changes
   live WhatsApp state MUST default to dry-run (exit 3, `dryRun: true`, `plan`)
   and MUST emit the dry-run BEFORE any provider/NATS/queue call — including
   read-only provider calls made on the send path (group-metadata resolution).
   Plans MUST replace phone/JID targets and text with bounded metadata:
   `group send` uses `{channel, accountId, instanceId, targetType, targetRef, effect,
   messageChars, mentionTargetCount}`; `group create` uses `{subjectChars,
   accountId, participantCount, requestedAdminCount, actorAdminCount, agentId,
   createAgent}`; add/remove/promote/demote use `{targetType, targetRef,
   participantCount, accountId}`; revoke/leave/settings use `{targetType,
   targetRef, effect, accountId}`
   (settings also has `setting`); join uses `{inviteProvided, accountId}`;
   rename adds `subjectChars`; description adds `descriptionChars`. DM plans use
   `{channel, accountId, targetType, targetRef, effect}` plus only `messageChars`,
   `messageCount`, or `receiptCount` as applicable. `targetType` is `group` or
   `contact`; `targetRef` is a stable SHA-256 prefix used only to distinguish
   targets. No target suffix, display name, phone, JID, subject, invite,
   message id, or message text may appear.
2. With `--json`, every failure on a migrated op MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedFlags?}}`.
3. Exit codes MUST follow the taxonomy: `0` success · `1` error (not-found /
   provider) · `2` usage error · `3` blocked by policy (write brake).
4. `whatsapp group info` on an unknown group MUST exit 1 with `GROUP_NOT_FOUND`
   and up to 3 `suggestions` built ONLY from the group list already fetched
   during resolution (omni REST, or the local chat model fallback) — never from
   an extra live call made just for suggestions.
5. Participant validation (`group create`, `group add`) and DM target
   resolution (`dm send|read|ack`) MUST fail unknown targets with
   `CONTACT_NOT_FOUND` (exit 1) and suggestions from the LOCAL contacts DB.
6. Validation and local resolution MUST run BEFORE the brake: an invalid
   setting, unknown contact, or unknown routed agent fails with its own error
   even in dry-run — the dry-run plan never promises an impossible write.
7. `whatsapp group list` and `whatsapp dm read` MUST accept `--fields a,b,c`
   for compact output.
8. When invoked from an agent context (`RAVI_*` envs present), a thrown
   `ContractError` MUST preserve its exit code through the registry dispatcher —
   the brake exits 3, never a generic `Error: ...` with exit 1.
9. Pure reads keep immediate behavior. `dm read --no-ack` reads local history
   directly; the default read path requires `--execute` only when it finds a
   message id and would send a receipt. `dm ack` always requires `--execute`.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| group send | message reaches real humans (high) | dry-run + `--execute` |
| group create | group creation notifies participants; also creates local chat/route/session (high) | dry-run + `--execute` |
| group add | adds real people, visible to the group (high) | dry-run + `--execute` |
| group remove | removes real people, socially irreversible (destructive) | dry-run + `--execute` |
| group promote / demote | grants/strips real admin power (high) | dry-run + `--execute` |
| group revoke-invite | kills links already shared (destructive) | dry-run + `--execute` |
| group rename / description / settings | changes what every member sees / who can post (high) | dry-run + `--execute` |
| group join / leave | membership changes visible to all members (high) | dry-run + `--execute` |
| dm send | message reaches a real person (high) | dry-run + `--execute` |
| group list / info / invite | reads | not braked (declared) |
| dm read --no-ack, or no receipt candidate | local history read | not braked |
| dm read with a receipt candidate / dm ack | external read-receipt emission | conditional dry-run + `--execute` |

`join`, `leave`, `description`, `settings` and `dm read` are authorized as
`mutate` because they can produce external effects. Exact legacy read grants
follow the [global compatibility
migration](../SPEC.md#authorization-and-confirmation-are-different-controls).

## Official error cases

| case | code | exit |
|---|---|---|
| group not found (info resolution) | `GROUP_NOT_FOUND` + suggestions from the already-fetched list | 1 |
| unknown participant / unresolvable DM target | `CONTACT_NOT_FOUND` + local-DB suggestions | 1 |
| braked write without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |
| invalid flag/arg (parser level) | `USAGE_ERROR` + acceptedFlags | 2 |

## Internal consumers

`src/plugins/internal/ravi-system/skills/whatsapp/SKILL.md` teaches this surface
and MUST document `--execute` on every braked op and list the unbraked ops
explicitly. Other teaching surfaces updated with `--execute`: the `agents` and
`architect` skills, `src/prompt-builder.ts` (group-create suggestion + sentinel
DM instructions), `docs/guides/whatsapp-groups.mdx` and `docs/cli/overview.mdx`.
The sentinel prompt teaches `dm read --no-ack` for silent local inspection and
`dm ack ... --execute` for an intentional external receipt.
Daemon-side outbound delivery publishes to NATS directly (channel senders), not
through this CLI, so the brake does not affect runtime message routing.

## Validation

- `bun test src/cli/commands/group.test.ts src/cli/commands/channels-json.test.ts`
  covers group writes plus conditional DM receipts, including zero NATS emits
  in dry-run and `--no-ack` compact reads.
- `bun tsc --noEmit` clean.
- Live checks (isolated `RAVI_STATE_DIR`, daemon running): `whatsapp group send
  <jid> "test" --json` → exit 3 and NO message delivered; adding `--execute`
  delivers; `whatsapp group info nope --json` → `GROUP_NOT_FOUND` exit 1.

## Known Failure Modes

- Parser-level usage errors use the global exit-2 `USAGE_ERROR` envelope with
  `acceptedFlags`.
- `group send` resolves group metadata via a provider call BEFORE sending when
  mentions are used; if the brake were placed after that resolution, dry-run
  would still hit the live bridge. The brake sits before ANY provider call.
- `group create` performs local side effects (agent creation via
  `--create-agent`, chat/route/session registration) after the WhatsApp call;
  the brake must stay ahead of `ensureGroupAgent`, or dry-run would create
  agents and directories.
- `validateParticipantsAreContacts` and `resolveWhatsAppJid` fail BEFORE the
  brake by design (invariant 6); moving them after would let a dry-run lie
  about an impossible write.
