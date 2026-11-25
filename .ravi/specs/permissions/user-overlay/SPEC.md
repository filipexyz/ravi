---
id: permissions/user-overlay
title: "Chat-Scoped User Overlay"
kind: capability
domain: permissions
capability: user-overlay
capabilities:
  - provider-runtime
  - agent-identity
  - contact-policy-permissions
  - profiles
  - chat-scope
  - runtime-context
tags:
  - permissions
  - contacts
  - chats
  - user-overlay
  - least-privilege
applies_to:
  - src/permissions/contact-chat-grants.ts
  - src/permissions/contact-policy-permissions-provider.ts
  - src/permissions/scope.ts
  - src/permissions/audit-provenance.ts
  - src/bash/hook.ts
  - src/runtime/context-registry.ts
  - src/runtime/runtime-request-context.ts
  - src/router/router-db.ts
  - src/cli/commands/permissions.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Chat-Scoped User Overlay

## Intent

A contact/user permission grant is scoped to a **chat** by default. The user
overlay narrows what the executor agent does for that contact in that chat; it
never widens the agent.

For a resolved contact speaking in a governed chat:

```text
effective_capabilities =
  agent_identity_capabilities           -- executor agent ceiling
  INTERSECT contact_chat_capabilities   -- grants covering (contact, chat)
  INTERSECT turn_capabilities_when_present
```

Agent identity remains the primary authority path
(`permissions/agent-identity`). The overlay is an additional branch on top of
it, not a replacement.

## Grant Scopes

A contact grant links one contact to one permission profile in exactly one
scope:

| Scope | CLI | Covers |
|-------|-----|--------|
| `chat:<chat-id>` | `--chat <chat-id\|current>` | one canonical chat and every thread inside it |
| `chat-tag:<tag>` | `--chat-tag <tag>` | every chat currently carrying that chat tag |
| `global` | `--force` | every chat (legacy contact permission tag) |

- Chat and chat-tag grants MUST be stored in the provider-owned
  `permission_contact_chat_grants` table in `ravi.db`, keyed by
  `(contact_id, profile_slug, scope_type, scope_id)`. The table is consumed only
  by `contact-policy-permissions`; it is not a generic relation graph.
- Grants MUST reference a profile by slug. Capabilities MUST be read from the
  profile (provider-owned `permission-*` tag definition) at materialization
  time, so editing a profile updates every grant that references it.
- Global grants MUST remain the existing contact permission tag
  (`kind=system`, `source=permissions`) attached to the contact.
- Chat grants MUST be keyed on the canonical chat id. A platform chat id MAY be
  accepted as input and resolved to the canonical id before storage.

## Threads

- Threads MUST inherit their container chat's grants. There is no separate
  thread grant model.
- A thread chat is a chat whose `normalized_chat_id` is
  `<container-normalized-id>#<thread-id>` on the same channel and instance.
- `--chat <thread-id>` MUST store the grant on the container chat and report
  the thread in the structured result (`threadChatId`) and hints.
- A turn in a thread MUST resolve grants against the container chat and record
  `userOverlayThreadChat` in context metadata.

## Governance

A chat is **governed** when at least one contact grant covers it: a direct
chat grant for any contact, or a chat-tag grant whose tag the chat carries.

- In an ungoverned chat the overlay MUST NOT change authority. The turn keeps
  the agent-identity path (`agent_identity ∩ turn_caps`) exactly as before.
- In a governed chat, the overlay MUST gate every resolved contact sender,
  except a lifted overlay (below):
  - a sender with covering grants receives
    `agent_identity ∩ contact_chat_caps (∩ turn_caps)`;
  - a sender with no covering grant receives zero tool capabilities
    (chat-only behavior for that sender in that chat).
- Global contact grants (`--force`) contribute capabilities only inside
  governed chats. A global grant alone MUST NOT govern a chat, so legacy global
  contact tags do not change ungoverned chats.
- Blocked or opted-out contacts, and contacts that no longer exist, MUST
  receive zero overlay capabilities in a governed chat.
- Explicit chat and chat-tag grants MUST NOT require
  `contact_policies.status=allowed` (group participants are often
  `discovered`/`pending`). Global contact permission tags keep the legacy
  `allowed` requirement (`permissions/tag-policy`). Status never implies
  capabilities by itself.
- Only contact actors on chat surfaces are overlaid. Automation, agent, and
  unresolved actors keep their existing paths (unresolved actors still fail
  closed).
- Task-self capabilities (`task-runtime:self:*`) MUST survive the overlay so a
  task session can still report on its own task.
- The executor agent ceiling MUST bound the result. A `chat-only` agent MUST
  still produce zero tool capabilities regardless of contact grants.

### Lifted Overlay

The overlay exists to reduce a sender to their chat grants. A contact whose own
power covers the agent's whole authority loses nothing to it, yet an overlay
turn also refuses automation and makes every thread it opens a held relay
(`permissions/agent-identity`). On 25/11 that held the operator (admin tag)
speaking in a chat where another person had a grant.

- The overlay MUST NOT be applied (it is **lifted**) only when both hold:
  - the contact's own power, held wherever it acts (its global permission
    tags, `ContactChatOverlay.globalCapabilities`, never a grant bound to this
    chat), holds full access: `admin:system:*` by the core matcher, the
    capability `permissions request full-access` grants;
  - nothing in the overlay as this chat reads it (chat, chat-tag and global
    grants) narrows the contact: no `deny_*` capability. With admin of its
    own, positive grants reduce nothing, so a deny is the only way the chat
    (or the contact's own tags) can hold the contact below the agent, and it
    keeps the overlay. Comparing effective sets MUST NOT decide this: an agent
    `deny_*` drops admin from both sides of that comparison, so a chat deny
    over authority the agent reaches through admin would go unseen and the
    live ceiling would hand it back (CodeRabbit on #990).
- Covering the agent's current effective set MUST NOT be enough. Admin on
  system short-circuits every check of the core matcher, in the snapshot and
  in the Bash hook's live executor ceiling alike, so full access covers this
  agent, any agent a relay or a job of the turn can reach, and this agent
  raised later. A narrower global tag does not: an agent `deny_*` drops admin
  from the agent's effective set while the live ceiling keeps the admin
  shortcut, an inform relay reaches a stronger agent unnarrowed, and a job
  can target a stronger agent (Devin on #990). Such a contact keeps the
  overlay, also for an agent that holds nothing (`chat-only`).
- A chat or chat-tag grant MUST NOT lift the overlay, full access included
  (what an approved `permissions request full-access` writes): automation
  written under it would run later as the whole agent and outlive the grant.
  Lifting that is a separate permission-model decision.
- A lifted turn takes the ungoverned path: `agent_identity (∩ turn_caps)`, with
  break-glass the contact does not hold withheld exactly as in an ungoverned
  chat (none, since its power covers the agent). Its `actorAuthorizationMode`
  is not `user-overlay`, so its automation is not held and the threads it
  opens are stamped `relayCallerUnrestricted` when their own rule allows.
- A cron job written in a lifted turn MUST be bound to the chat
  (`creatorChat`), as an overlay turn's job is, so it never outlives the full
  access it was written under (review of #990, N3). The held-relay guard of
  `cron add|set` still reads the overlay mode alone: a held relay whose own
  overlay is lifted binds nothing and writes no job. Since a bound job may now
  run as the agent (a lifted owner), the binding no longer proves the job is
  limited: a turn held below the agent (`automationHoldCause` not null) MAY
  enable it, change a key that keeps its owner (`description`, `cron`,
  `every`, `tz`, `timezone`, `timeout`, `delete-after`), run it now
  (`cron run`, which fires even a disabled job) or delete it (`cron rm`) only
  when it owns the job (review of #991, B1 and N7). Disabling stays open to
  any turn: it only reduces, and the owner can enable it again.
- The lift is decided on every turn, from the grants and tags as they are at
  that turn, also for a cron job bound to the chat (`creatorChat`): the job of
  an owner with full access runs as the agent, and is narrowed to the owner's
  chat grants (none: no capabilities) once that full access is withdrawn.
- A relay built from a lifted turn (any action: inform, answer, return, or a
  work handoff, also queued after the turn ended) MUST re-validate that lift
  from the `userOverlayContact` and `userOverlayChat` the caller recorded,
  against the grants and tags as they are then. Withdrawn (an untag or
  `permissions deny`) or narrowed by a `deny_*` since: the caller lends
  nothing, as a profile withdrawal does, and the relay is held. A lifted
  context missing either field lends nothing (review of #990, N2).
- A lifted turn MUST record `userOverlayGrants` like an applied one, so
  `permissions deny` of the grant it rests on (for the admin tag,
  `<tag>@global`) and a profile narrowing revoke the live turn. Applied and
  lifted overlays record their owner as `userOverlayContact`, and
  `revokeLiveRuntimeContextsForContactGrant` matches it as well as the actor:
  a cron run acts as `automation:cron:<id>` under its owner's overlay.
- The active-turn lease MUST NOT revoke an overlay turn whose overlay is lifted
  at renewal (the contact gained full access mid-turn): that is a gain. The
  turn keeps its issued snapshot, mode and holds until it ends; the lift
  applies from the next turn. A lifted turn whose contact loses full access
  mid-turn changes mode at renewal and is revoked, and so does an overlay turn
  whose chat stops being governed mid-turn: only a lift relaxes the mode.

## Enforcement And Freshness

- The overlay MUST be resolved at turn start and persisted in the turn's
  capability snapshot. Every enforcement point that reads the snapshot
  (context-capabilities provider, CLI command access, host tool
  authorization) enforces it without extra wiring.
- The Bash/tool PreToolUse hook normally re-reads the live executor ceiling
  for resolved agent-identity turns. For `actorAuthorizationMode=user-overlay`
  turns it MUST require both the issued snapshot and the live ceiling, so the
  live ceiling can narrow the overlay but never replace it.
- `ravi permissions deny --apply` MUST revoke live runtime contexts whose
  `userOverlayGrants` contain the revoked `<profile>@<scope>` for that contact,
  like `ravi agents permissions` does for agent reductions.
- New grants, chat-tag changes, and a first grant that makes a chat governed
  apply from the next turn. In-flight turns of other senders keep their
  snapshot until they end.

## Runtime Context Metadata

When the actor is a contact on a chat surface, the turn context MUST record:

- `actorAuthorizationMode=user-overlay` when the overlay gated the turn
  (otherwise the existing `invoke-only` / `not-applicable`, also when lifted);
- `userOverlay`: `active`, `lifted` (governed chat, overlay not applied
  because the contact's own power covers the agent) or `inactive`;
- `userOverlayChat`: `chat:<container-chat-id>`;
- `userOverlayThreadChat`: `chat:<thread-chat-id>` for thread turns;
- `userOverlayGrants`: `<profile>@<scope>` list when active or lifted;
- `userOverlayContact`: `contact:<id>` owner of those grants, when active or
  lifted;
- `userOverlayEligible=false` when active and the contact is blocked/opted
  out/missing;
- `actorCapabilityCount`: overlay capability count when active, else `0`.

Materialized overlay capabilities MUST carry provenance:

- `contact-policy:contact:<id>:chat:<chat-id>:profile:<slug>`
- `contact-policy:contact:<id>:chat-tag:<tag>:profile:<slug>`
- `contact-policy:contact:<id>:tag:<slug>` (global)
- `contact-policy:contact:<id>:admin-tag` (compatibility admin tags)

Audit provenance MUST carry `userOverlay`, `userOverlayChat`,
`userOverlayThreadChat`, and `userOverlayGrants` when present.

## Denials

A denial from an overlay-gated turn MUST be diagnosed as
`user_overlay_missing_grant` and MUST recommend a chat-scoped grant:

```bash
ravi permissions allow <profile> --to contact:<actor-id> --chat <chat-id> \
  --agent <executor-agent-id> --capabilities <permission>:<objectType>:<objectId>
```

`ravi permissions resolve <denial-id>` for such a denial MUST infer
`contact:<actor-id>`, the denied chat, and the executor agent, and plan a grant
scoped to that chat. An explicit `--chat`, `--chat-tag`, or `--force` replaces
the inferred scope; `resolve` MUST NOT go global without `--force`.

## CLI Contract

```bash
ravi permissions allow <profile> --to contact:<id> --chat <chat-id|current> [--agent <id>] [--apply]
ravi permissions allow <profile> --to contact:<id> --chat-tag <tag> [--agent <id>] [--apply]
ravi permissions allow <profile> --to contact:<id> --force [--apply]
ravi permissions deny  <profile> --to contact:<id> (--chat <chat> | --chat-tag <tag> | --force) [--apply]
ravi permissions list  [--to contact:<id>] (--chat <chat> | --chat-tag <tag> | --force) [--profile <p>] [--limit <n>] [--offset <n>]
```

Rules:

- `allow`, `deny`, and `list` targeting contacts MUST require exactly one scope
  kind: `--chat` and/or `--chat-tag`, or `--force`. Without a scope they MUST
  refuse with code `CHAT_SCOPE_REQUIRED` (exit 2) before any mutation. The
  error MUST list accepted flags and, when a current chat is known, suggest
  `--chat <current-chat-id>`.
- `--force` combined with `--chat`/`--chat-tag` MUST fail with `USAGE_ERROR`.
- `--chat`/`--chat-tag`/`--force` without any contact target on `allow` MUST
  fail with `USAGE_ERROR`; agent-only `allow` keeps its existing contract.
- `deny` MUST accept only `contact:<id>` targets.
- `--chat current` MUST resolve from the current runtime context; outside a
  chat it MUST fail.
- `allow` MUST reject an unknown chat (`CHAT_NOT_FOUND`); an ambiguous
  platform chat id MUST fail with `CHAT_AMBIGUOUS`.
- Unknown contacts MUST fail with `CONTACT_NOT_FOUND` before any mutation.
- `allow` and `deny` MUST dry-run by default and persist only with `--apply`.
- `--force` MUST emit a hint that the safer default is a specific chat/group,
  so the agent asks the human first (e.g. "only in this group?").
- `allow` SHOULD hint when a chat becomes governed (other senders lose tool
  access there), when a thread was mapped to its container chat, and when no
  `--agent` ceiling was ensured.
- `deny` SHOULD hint when grants in other scopes still cover the contact and
  when a chat stops being governed.

### Structured Confirmation

`allow`, `deny`, and `list` JSON output MUST include a `confirmation` object:

```json
{
  "action": "allow",
  "dryRun": false,
  "contacts": ["contact:<id>"],
  "agents": ["agent:<id>"],
  "scopes": ["chat:<chat-id>"],
  "global": false,
  "force": false,
  "profile": "permission-<slug>",
  "capabilities": ["<permission>:<objectType>:<objectId>"],
  "message": "Granted permission-<slug> to contact:<id> only in chat:<chat-id> (not global)."
}
```

- `scopes` MUST be `chat:<id>`, `chat-tag:<tag>`, or `global`.
- `global` MUST be `true` only when `--force` was used.
- `list` MUST also return `grants[]` (`contact`, `profile`, `scope`,
  `scopeType`, `source`, `capabilities`) and, for chat scopes, `overlays[]`
  (`contact`, `chat`, `governed`, `eligible`, `capabilities`).
- `list` MUST page `grants[]` with `--limit`/`--offset` and return `total`
  plus `pagination` (with `nextCommand` while more grants match); the
  confirmation message MUST say "N of M" when a page is partial.

## Known Limits

- Merging contacts does not move chat grants; grants on the merged-away
  contact stop applying (fail closed).
- Chat-tag coverage is evaluated at turn time; tagging or untagging a chat
  changes coverage on the next turn without touching grants.

## Acceptance Criteria

- Contact `allow`/`deny`/`list` without `--chat`, `--chat-tag`, or `--force`
  is refused with `CHAT_SCOPE_REQUIRED` and writes nothing.
- A chat-scoped grant gives the contact
  `agent_identity ∩ profile_caps` only in that chat.
- A chat-tag grant covers every chat carrying the tag.
- A thread turn uses its container chat's grants.
- Contact capabilities outside the executor agent ceiling never materialize.
- `--force` creates a global grant, reports `global=true`, `force=true`, and
  emits the safer-default hint.
- Structured confirmation reports subject, scope, profile, capabilities, and
  force for allow, deny, and list.
- Ungoverned chats keep the agent-identity result unchanged.
- In a governed chat, a contact whose global permission tags hold full access
  (the operator) gets the agent-identity result, `userOverlay=lifted`, no
  automation hold and stamped threads; a contact whose power there comes from
  a chat grant (full access included), a partial grant, no grant, a global
  tag without full access (even one covering the agent's effective set), or a
  `deny_*` in the chat's grants or in their own tags keeps the overlay and its
  holds.
