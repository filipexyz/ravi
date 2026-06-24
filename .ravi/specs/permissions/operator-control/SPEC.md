---
id: permissions/operator-control
title: "Operator Control"
kind: capability
domain: permissions
capability: operator-control
tags:
  - permissions
  - provider-runtime
  - operator-control
applies_to:
  - src/permissions/operator-control-provider.ts
  - src/permissions/provider-registry.ts
  - src/cli/commands/permissions.ts
  - src/cli/commands/doctor.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Operator Control

## Intent

`operator-control` authorizes explicit operator management actions in the
Permission Provider Runtime.

It exists so local management and future remote management can use a real
provider instead of being confused with agent execution authority.

## Rules

- `operator-control` MUST be the provider id for explicit operator control
  actions.
- The provider MUST allow only explicit local requests where
  `localOperator=true` and no subject, context, or capability snapshot is
  present.
- Missing subject/context MUST NOT imply operator authority without that
  explicit flag.
- `operator-control` MUST NOT materialize capabilities.
- `operator-control` MUST NOT be used to authorize agent tool execution,
  executable execution, app execution, or session runtime actions.
- Agent execution authority remains owned by `agent-identity-permissions` and
  materialized capabilities.
- Provider-owned management commands such as `ravi permissions allow` and
  `ravi permissions resolve` MAY use operator-control to prove the operator
  path, then mutate only provider-owned configuration.
- The CLI flag name `--local-operator` is compatibility UI. Specs, doctor
  checks, logs, and provider diagnostics SHOULD identify the provider as
  `operator-control`.

## Future Remote Management

Remote management MUST be added as an authenticated operator identity path, not
by granting more power to agents or reintroducing a relation graph.

The expected future shape is:

1. authenticate an operator identity;
2. authorize the management action through an operator provider;
3. issue or update a provider-owned profile, tag, or bounded runtime grant;
4. let agent identity enforcement evaluate the runtime action separately.
