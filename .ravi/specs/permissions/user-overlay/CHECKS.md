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
- In a governed chat, a contact whose global permission tags cover a
  full-access agent MUST get `userOverlay=lifted`, `actorAuthorizationMode`
  other than `user-overlay`, no automation hold, `userOverlayGrants` recorded,
  and threads (and their return) stamped `relayCallerUnrestricted`
  (`runtime-request-context.test.ts`, "a contact speaking in a chat governed by
  contact grants").
- In a governed chat the overlay MUST stay (`userOverlay=active`, automation
  held, threads held) for: a partial chat grant, no grant, a partial global
  tag, full access granted only in that chat, a partial global tag plus full
  access in that chat, an admin with a `deny_*` grant in that chat, and any
  contact of a `chat-only` agent (same test block).
- `deny` of the global grant a lifted turn rests on MUST revoke that live turn,
  and the next turn without it MUST be narrowed again (same test block).
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
