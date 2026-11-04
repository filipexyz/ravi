---
id: permissions/profiles/checks
title: "Permission Profile Checks"
kind: checks
domain: permissions
capability: profiles
---

# Permission Profile Checks

## Regression Tests

- `bun test --preload ./src/test/isolated-runtime-preload.ts src/cli/commands/permissions.test.ts`
  covers all four built-ins before tag creation: dry-run without writes,
  allow/deny expansion parity with the executor materializers, apply of eligible
  profiles to a human in a Slack chat, read-back with `permissions list --chat`, empty grants,
  idempotent replay and revoke. A second contact stays at zero authority.
- Unknown profiles MUST name the available profiles and concrete inspection
  commands. A `full-access` preview MUST include the expanded ceiling and the
  explicit operator-approval requirement. `allow`/`resolve --profile full-access
  --apply` MUST fail with `FULL_ACCESS_APPROVAL_REQUIRED` before any profile,
  contact grant or agent-ceiling write while verified approval consumption is
  unavailable. The dry-run MUST NOT suggest that blocked apply command.
- More than 500 stored profiles, including older rows behind newer non-profile
  tags, MUST all appear in `acceptedValues`; the inline diagnostic stays bounded.

- Materialize an agent with `agent.defaults.runtimePermissions.profile =
  "full-access"` and assert `admin system:*`, `execute executable:*`,
  `use tool:*`, and `use skill:*` appear with `agent-default-capabilities`
  provenance.
- Persist `chat-only` as `{ profile: "chat-only" }` (never `null`). Materialize
  of that agent and its `agent_identity` MUST have no `use:tool:*` and no
  bootstrap execute groups/executables. `permissions <id> none` MUST still
  restore the bootstrap floor.
- CLI/help for `agents permissions` MUST list `chat-only` beside
  bootstrap/full-access and MUST describe `none`/`clear`/`off` as reset to
  bootstrap minimum, not zero-authority.
- Materialize an agent with explicit runtime capabilities and assert only those
  capabilities are added beyond bootstrap.
- Materialize a contact tagged `permission.admin` and assert admin authority
  appears only through `contact-policy-permissions`.
- `permissions allow <profile> --to contact:<id>` without `--chat`,
  `--chat-tag`, or `--force` MUST fail with `CHAT_SCOPE_REQUIRED`; with
  `--chat` it MUST store a chat-scoped grant and MUST NOT attach a global
  contact tag.
- Add a generic CRM tag and assert it does not materialize runtime authority.
- Build delegated authority with agent, actor, surface, and turn capabilities;
  assert intersection, surface inheritance, explicit deny, constraints, and
  overrides match `src/permissions/delegation.test.ts`.
- Create an agent under a runtime creator and assert creator visibility is
  persisted as `view agent:<created-id>` in provider-owned config.
- Initialize the DB with existing agents and assert the default agent
  materializes `view agent:*`.
- CLI/help output for `agents create`, `agents permissions`, command-access
  denials, and permission approval prompts MUST present profile/tag or
  least-privilege inspection as the normal next step and label `full-access` as
  break-glass.
- `permissions check --json` for a denied capability MUST include the shared
  guidance envelope with `canonicalCapability`, `inspectCommands`,
  `preferredPath`, `rawCapabilityFallback`, `breakGlass`, `requestShape`, and
  `nextSteps`.
- When a provider-owned system tag from source `permissions` contains the
  missing capability, `permissions check` and command-access denial guidance
  MUST name that tag in `preferredPath.suggestedTags`.
- Permission approval prompts MUST say the approval is for the current context
  only and point recurring access to provider-owned profile/tag policy.
- The installed `ravi-system-permissions-manager` skill MUST teach agents to
  materialize/check first, ask for provider-owned profiles/tags for recurring
  access, and avoid `full-access` except break-glass.

## Commands

```bash
bun test src/permissions/provider-runtime.test.ts
bun test src/permissions/chat-only-parity.test.ts
bun test src/permissions/delegation.test.ts
bun test src/cli/commands/agents.test.ts
bun test src/cli/commands/permissions.test.ts src/cli/command-access.test.ts src/approval/service.test.ts
```

## Shared definition reductions

- `bun test --preload ./src/test/isolated-runtime-preload.ts src/cli/commands/permissions.test.ts`
  MUST cover a legacy chat-only definition shared by multiple contacts and chat,
  chat-tag and global grants: dry-run leaves snapshots live, apply revokes all
  affected roots, descendants and actor projections, and another profile stays
  live. A rejected context write MUST roll back the profile and all revocations.
- `bun test --preload ./src/test/isolated-runtime-preload.ts src/permissions/apply-grant.test.ts src/runtime/context-registry.test.ts`
  MUST retain direct profile-source snapshot revocation and prove label-only and
  additive updates leave existing contexts live.
  Regressions MUST cover live issued children behind revoked roots/projections
  and unrelated colon-bearing profile names that share the target's suffix.
- `bun test --preload ./src/test/isolated-runtime-preload.ts src/runtime/runtime-request-context.test.ts`
  MUST revoke issued and chained relays after a shared profile reduction and
  prevent queued relays from historical callers restoring the old authority.
  Ordinary turn rotation MUST still allow queued relays to preserve their
  original narrowing, and contact attribution MUST survive authority withdrawal.
