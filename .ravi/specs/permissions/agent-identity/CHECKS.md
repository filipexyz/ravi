# Agent Identity Authority / CHECKS

## Checks

- In an ungoverned chat, a resolved contact SHOULD be able to invoke
  capabilities held by the agent identity even when the contact has zero
  materialized capabilities.
- In a governed chat, effective capabilities MUST be
  `agent_identity ∩ contact_chat_caps`, and contact capabilities outside the
  agent identity MUST NOT materialize.
- A chat with zero materialized capabilities MUST NOT zero the agent identity.
- An unresolved external actor MUST receive zero effective capabilities.
- Runtime approval MUST deny an unresolved external actor's missing capability
  without sending an approval request (`src/approval/service.test.ts`).
- Agent-identity denials MUST resolve recommended grants to
  `agent:<executor>`; user-overlay denials MUST also recommend a chat-scoped
  contact grant.
- The default materializer chain MUST include `agent-identity-permissions`.
- `bun test src/permissions/provider-runtime.test.ts src/runtime/runtime-request-context.test.ts`
  SHOULD pass after changing agent identity materialization.
- A contact turn in an ungoverned chat MUST NOT hold `admin:system:*` or
  `execute:executable:*` from the agent identity unless the contact holds it;
  an owner contact keeps it; revoking the chat's last grant MUST NOT widen
  (`runtime-request-context.test.ts`, "never lets a person's turn in an
  ungoverned chat inherit the agent's break-glass").
