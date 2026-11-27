# Permissions / CHECKS

## Checks

- Permission checks MUST fail closed when principal, action, object, or context
  cannot be resolved.
- Runtime checks MUST use canonical Ravi subjects and objects, not display names
  or raw provider ids.
- External shared-surface execution MUST authorize through agent identity and
  explicit turn caps, with actor/contact retained as provenance.
- Contact policy status MUST NOT be treated as tool, CLI, app, session, or
  gateway authority.
- Discovery surfaces MUST filter to resources visible to the effective context.
- Contact grants via `ravi permissions allow|deny|list` MUST require `--chat`,
  `--chat-tag`, or `--force`, and MUST return a structured `confirmation`.
- In a governed chat, effective capabilities MUST be
  `agent_identity ∩ contact_chat_caps`; ungoverned chats MUST keep the
  agent-identity result (`permissions/user-overlay`).
- A runtime capability approval in a direct chat whose contact actor lacks the
  capability MUST be refused before any delivery, request row or
  `ravi.approval.request` event; a group chat and a requester who can grant
  MUST still be asked (`src/approval/service.test.ts`, "a direct chat whose
  requester cannot grant").
- `bun test src/permissions/provider-runtime.test.ts src/permissions/capability-context.test.ts src/permissions/delegation.test.ts src/permissions/denials.test.ts`
  SHOULD pass after changing permission behavior.
- `bun test src/cli/commands/permissions.test.ts src/runtime/runtime-request-context.test.ts src/permissions/scope.test.ts`
  SHOULD pass after changing contact grants or the user overlay.
