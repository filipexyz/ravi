# Chat-Scoped User Overlay / CHECKS

## Checks

- `ravi permissions allow|deny|list` targeting `contact:<id>` without
  `--chat`, `--chat-tag`, or `--force` MUST fail with `CHAT_SCOPE_REQUIRED`
  (exit 2) and MUST NOT write grants or tags.
- The refusal SHOULD suggest `--chat <current-chat-id>` when run inside a chat
  context.
- `--force` together with `--chat` or `--chat-tag` MUST fail with
  `USAGE_ERROR`.
- A chat-scoped `allow --apply` MUST store one `permission_contact_chat_grants`
  row keyed on the canonical container chat and MUST NOT attach a global
  contact tag.
- `allow --chat <thread-id>` MUST store the grant on the container chat and
  report `threadChatId`.
- A chat-tag grant MUST cover every chat carrying the tag and no other chat.
- In a governed chat, effective capabilities MUST equal
  `agent_identity ∩ contact_chat_caps`; profile capabilities outside the agent
  ceiling MUST NOT materialize.
- In an ungoverned chat, effective capabilities MUST equal the agent-identity
  result.
- In a governed chat, a sender without a covering grant MUST receive zero tool
  capabilities.
- A thread turn MUST resolve grants from its container chat and record
  `userOverlayThreadChat`.
- In a governed chat, a contact whose global permission tags hold full access
  MUST get `userOverlay=lifted`, `actorAuthorizationMode` other than
  `user-overlay`, no automation hold, `userOverlayGrants` and
  `userOverlayContact` recorded, and threads (and their return) stamped
  `relayCallerUnrestricted` (`runtime-request-context.test.ts`, "a contact
  speaking in a chat governed by contact grants").
- In a governed chat the overlay MUST stay (`userOverlay=active`, automation
  held, threads held) for: a partial chat grant, no grant, a partial global
  tag, full access granted only in that chat, a partial global tag plus full
  access in that chat, an admin with a `deny_*` grant in that chat (also when
  the agent holds admin plus a `deny_*` of its own, which hides admin from an
  effective-set comparison), an admin with a `deny_*` among their own tags, a
  global tag that covers the effective set of an agent holding admin plus a
  `deny_*`, and a member or a global-tag holder of a `chat-only` agent (same
  test block).
- `deny` of the global grant a lifted turn rests on MUST revoke that live turn,
  and the next turn without it MUST be narrowed again (same test block); it
  MUST also revoke a live lifted cron run of that owner, found by
  `userOverlayContact` ("runs a chat-bound cron of an owner…").
- The active-turn lease MUST keep an overlay turn whose contact gains full
  access mid-turn (issued snapshot and mode unchanged, lifted on the next
  turn), MUST revoke a lifted turn whose contact loses it, and MUST revoke an
  overlay turn whose chat stops being governed mid-turn
  (`runtime-request-context-lifetime.test.ts`, "a contact in a chat governed by
  contact grants").
- A relay from a lifted turn MUST lend nothing (zero capabilities,
  `held-relay`) for every action once the contact is untagged or narrowed by a
  `deny_*` granted in the chat, and MUST still carry the destination's
  authority while the full access holds; a lifted context missing
  `userOverlayContact` or `userOverlayChat` MUST lend nothing
  (`runtime-request-context.test.ts`, "a relay from a lifted turn lends
  nothing…", "a lifted caller whose context lacks…").
- `cron add` in a lifted turn MUST bind the job to the chat; in a held relay
  whose own overlay is lifted it MUST refuse (`cron-commands.test.ts`, "binds
  a job from an overlay turn or a lifted overlay to its chat…").
- A global (`--force`) grant MUST apply only inside governed chats and MUST NOT
  govern a chat by itself.
- Blocked contacts MUST receive zero overlay capabilities.
- A `pending` contact with an explicit chat grant MUST receive the granted
  capabilities; a `pending` contact with only a global permission tag MUST NOT.
- `allow`, `deny`, and `list` JSON MUST include `confirmation` with `action`,
  `dryRun`, `contacts`, `agents`, `scopes`, `global`, `force`, `profile`,
  `capabilities`, and `message`.
- `--force` MUST return `global=true`, `force=true`, and a safer-default hint.
- `list --limit <n>` MUST return at most `n` grants, the full `total`, and a
  `pagination.nextCommand` that fetches the next page with the same scope.
- Overlay-gated denials MUST diagnose `user_overlay_missing_grant` and
  `resolve` MUST plan a chat-scoped contact grant.
- The Bash/tool hook MUST deny a user-overlay turn anything outside its issued
  snapshot, even when the executor agent has `full-access`, and MUST still
  apply a live executor reduction.
- `deny --apply` MUST revoke live contexts that used the revoked grant and
  MUST NOT revoke contexts of other chats or contacts.

## Commands

```bash
bun test src/cli/commands/permissions.test.ts
bun test src/runtime/runtime-request-context.test.ts src/runtime/context-registry.test.ts
bun test src/permissions/scope.test.ts
bun test src/bash/hook.test.ts
bun test src/router/chat-schema.test.ts
```
