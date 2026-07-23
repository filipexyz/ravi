# Agent Identity Authority / CHECKS

## Checks

- A resolved contact in a chat SHOULD be able to invoke capabilities held by
  the agent identity even when the contact has zero materialized capabilities.
- A chat with zero materialized capabilities MUST NOT zero the agent identity.
- An unresolved external actor MUST receive zero effective capabilities.
- Agent-identity denials MUST resolve recommended grants to
  `agent:<executor>`.
- The default materializer chain MUST include `agent-identity-permissions`.
- `bun test src/permissions/provider-runtime.test.ts src/runtime/runtime-request-context.test.ts`
  SHOULD pass after changing agent identity materialization.
