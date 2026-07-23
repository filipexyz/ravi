---
id: permissions/profiles/checks
title: "Permission Profile Checks"
kind: checks
domain: permissions
capability: profiles
---

# Permission Profile Checks

## Regression Tests

- Materialize an agent with `agent.defaults.runtimePermissions.profile =
  "full-access"` and assert `admin system:*` appears with
  `agent-default-capabilities` provenance.
- Materialize an agent with explicit runtime capabilities and assert only those
  capabilities are added beyond bootstrap.
- Materialize a contact tagged `permission.admin` and assert admin authority
  appears only through `contact-policy-permissions`.
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
bun test src/permissions/delegation.test.ts
bun test src/cli/commands/agents.test.ts
bun test src/cli/commands/permissions.test.ts src/cli/command-access.test.ts src/approval/service.test.ts
```
