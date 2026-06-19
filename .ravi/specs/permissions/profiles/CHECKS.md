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
  `agent-runtime-permissions` provenance.
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

## Commands

```bash
bun test src/permissions/provider-runtime.test.ts
bun test src/permissions/delegation.test.ts
bun test src/cli/commands/agents.test.ts
```
