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
- A contact turn in an ungoverned chat with a full-access agent MUST keep
  ordinary capabilities (image, tools) and MUST NOT get `admin:system:*` nor
  run arbitrary commands through the Bash hook; the owner keeps both
  (`delegated-turn-enforcement.test.ts`, "full-access minus break-glass",
  "keeps the owner's break-glass"; `runtime-request-context.test.ts`,
  "never lets a person's turn in an ungoverned chat inherit the agent's
  break-glass").
- A denial carrying `actorBreakGlassWithheld` MUST resolve to a chat-scoped
  contact grant (`permissions.test.ts`, "withheld break-glass denial").
- A turn relayed from a person's ungoverned-chat turn MUST keep ordinary
  capabilities and stay without admin and executables
  (`runtime-request-context.test.ts`, break-glass case, relay block).
- Automation writes (cron, triggers, followups, hooks, signals, tasks) MUST be
  refused in a turn with `actorBreakGlassWithheld`
  (`user-overlay-automation.test.ts`, `cron-commands.test.ts`).
- A writer that reaches the automation stores directly from a turn with
  `actorBreakGlassWithheld` MUST be refused (`automation-store-guard.test.ts`);
  `watch trigger` MUST refuse even as a dry-run (`watch.test.ts`).
- The CI follow of `pr publish` MUST be registered from a held (relayed) turn,
  and ONLY the canonical one: another message, an extra field, a later write,
  an async scope body or a non-publication caller MUST still be refused
  (`gh-watch.test.ts`, "the CI follow that `pr publish` leaves";
  `automation-store-guard.test.ts`, "canonical-follow scope").
- An app command resolving to anything but Ravi MUST be refused in a turn
  that withholds `execute:executable:*` (`turn-executable.test.ts`); observer
  rules written from such a turn MUST be refused (`automation-store-guard.test.ts`).
- A limited person's file write outside the session workspace and temp
  (`~/.ravi/.env`, installed bundle, `~/.zshrc`, LaunchAgents, a symlink
  escaping the workspace) MUST be refused (`provider-config-writes.test.ts`).
- With the session workspace set to the Ravi state dir or `~/.ravi`, a limited
  person's write to `.env` MUST still be refused (`provider-config-writes.test.ts`);
  moving an agent's `cwd` or creating an agent in a limited turn MUST be refused,
  and a derived context with only inherited `deny_*` MUST be held
  (`automation-store-guard.test.ts`).
