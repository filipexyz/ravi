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
- The operator's own relay (a thread they asked for) MUST write a trigger, a cron
  job and the CI follow of `pr publish`; a relay of an overlay turn, of a turn
  holding `deny_*`, of a held relay, a relay to an agent with more authority than the caller's ceiling (also with N>=3 specific grants inside the target's wildcards), or one without the `relayCallerUnrestricted`
  stamp MUST still be refused (`runtime-request-context.test.ts`,
  `user-overlay-automation.test.ts`, `automation-store-guard.test.ts`,
  `gh-watch.test.ts`, `cron-commands.test.ts`).
- The return of the operator's thread to the agent that opened it
  (`session.return`) MUST be stamped and pass the automation guards; the return of
  a thread opened from a person with no grant MUST stay held
  (`runtime-request-context.test.ts`).
- The automation refusal MUST name its cause, in the command and the store
  guard: a held relay (also one narrowed to a governed chat's grants, and a
  stamped relay that still carries withheld break-glass) says it is a relay and
  that a grant does not lift it, and never speaks of a contact's chat
  permissions; a person with no grant and an overlay turn say theirs; no advice
  points at a grant (`user-overlay-automation.test.ts`,
  `runtime-request-context.test.ts`). The `automationHold` field MUST reach the
  envelope (allowlisted; other details dropped, diagnostic and advice not
  replaceable) and the `pr publish` follow refusal (`agent-contract.test.ts`,
  `pr/service.test.ts`); the remote CLI MUST map each known cause to its fixed
  advice and keep the generic denial advice for an unknown cause or none, and a
  `failed` or `blocked` body carrying a cause MUST keep its own advice
  (`remote-gateway.test.ts`).
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
- A relative `--out` / `--output` / `--download` / `rules import --cwd` MUST be
  resolved against the caller's cwd, and the worker or writer MUST receive that
  resolved path, never the raw value (`meetings.test.ts`, `cloud-agents.test.ts`,
  `caller-cwd.test.ts`); a limited person downloading cloud outputs or importing
  rules outside the workspace MUST be refused before the cloud is contacted or
  any file is written.
- Disabling an existing observer rule from a limited turn MUST be judged on the
  stored columns, both sides normalized the same way: repeating what is stored
  (also a rule whose stored JSON predates normalization) still disables, any
  other stored change is refused (`automation-store-guard.test.ts`,
  `observation-plane.test.ts`).
- A limited person's CLI write boundary MUST be the authenticated session's
  workspace (`expandHome(session.agentCwd)` from the context's `sessionKey`),
  never the cwd the caller declares; a context with no session keeps only temp
  writable (`caller-cwd.test.ts`). A leading `~` in a CLI path MUST be read as
  the home directory before the check, so the path handed to a worker is the
  one checked.
