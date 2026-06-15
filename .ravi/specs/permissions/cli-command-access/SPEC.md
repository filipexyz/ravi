---
id: permissions/cli-command-access
title: "CLI Command Access"
kind: capability
domain: permissions
capability: cli-command-access
capabilities:
  - cli-command-access
  - command-decorators
  - provider-runtime
  - doctor
tags:
  - permissions
  - cli
  - provider-runtime
  - security
applies_to:
  - src/cli/decorators.ts
  - src/cli/registry-snapshot.ts
  - src/cli/tools-export.ts
  - src/permissions/scope.ts
  - src/permissions/provider-runtime.ts
  - src/cli/commands/doctor.ts
owners:
  - ravi-dev
status: active
normative: true
---

# CLI Command Access

## Intent

CLI command access metadata declares what a command does so the Permission
Provider Runtime can decide whether it may run.

The decorator is a contract, not a grant and not policy. It MUST NOT encode
REBAC relations, role expansion, subject grants, or local allowlists. It exists
to turn a decorated CLI method into a typed provider-runtime request.

## Decorator

Ravi MUST expose a command-level decorator named `@CommandAccess`.

Example:

```ts
@CommandAccess({
  kind: "mutate",
  resource: "session.subscription",
  action: "attach",
  risk: "medium",
  requiresContext: ["actor", "surface", "session", "executorAgent"],
})
@Command({ name: "attach", description: "Attach a chat to a session" })
async attach(...) {}
```

Minimum fields:

- `kind`: `read` or `mutate`.
- `resource`: canonical semantic resource type, for example `task`,
  `calendar.event`, `session.subscription`, or `whatsapp.message`.
- `action`: canonical verb, for example `list`, `create`, `send`, `attach`,
  `delete`, `sync`, or `run`.
- `risk`: `low`, `medium`, `high`, or `destructive`.

Optional fields:

- `requiresContext`: required runtime principals, such as `actor`, `surface`,
  `session`, `executorAgent`, or `resource`.
- `resourceId`: how the command resolves the concrete resource id, when a
  concrete id exists.
- `input`: selected argument/option names that may be copied into the
  permission request after redaction.
- `redactions`: command-specific input fields that MUST be redacted before
  provider execution or audit.
- `localOperator`: whether direct local CLI with no principal may use the
  explicit local-operator provider path.
- `notes`: short human-readable operator note for doctor/review output.

## Relationship To `@Scope`

`@Scope` is a coarse execution boundary and MUST NOT be the domain permission
model.

Rules:

- `@Scope("open")` MUST NOT mean "safe for agents/tools to mutate".
- `@Scope("admin")` MUST NOT be used as the default answer to missing command
  policy.
- `@Scope("resource")` MAY remain as a command-layer ownership hint, but it
  MUST still use `@CommandAccess` to describe the operation.
- New public CLI commands MUST declare `@CommandAccess` before they are
  exposed to SDK, tools, or gateway surfaces.
- Existing `@Scope` checks MAY remain during migration only as a compatibility
  guard. They MUST NOT bypass the Permission Provider Runtime.

## Registry Contract

`src/cli/registry-snapshot.ts` MUST expose command access metadata for every
decorated command.

The registry entry MUST include:

- `access.kind`
- `access.resource`
- `access.action`
- `access.risk`
- optional context, resource-id, input, redaction, and local-operator metadata

Commands marked `@CliOnly` MAY omit `@CommandAccess` when they are strictly
interactive, streaming, process-local, or not exposed to remote/tool execution.

All non-CLI-only commands MUST have `@CommandAccess` after the migration gate is
enabled. During migration, missing metadata MAY remain only when doctor reports
it explicitly. The production target is zero public commands with missing
command access metadata.

## Provider Runtime Mapping

When a command is executed by an agent, SDK gateway, tool export, app runtime,
automation, or any context with a resolved principal, Ravi MUST build a
`PermissionProviderRequest` from the command access metadata.

The request MUST include:

- request id
- command group and command name
- command access metadata
- canonical actor, surface, session, executor agent, and automation context
  when available
- selected and redacted input only
- raw channel ids only as provenance, never as authority

The request MUST NOT include raw context keys, bearer tokens, cookies,
credentials, secret env values, or arbitrary unredacted command payloads.

The provider runtime owns the decision. The command decorator MUST NOT decide
whether a subject is allowed.

## Local Operator

Direct terminal use without a resolved runtime principal MAY be authorized by
the explicit `local-operator` provider only when the command metadata allows
that path.

Rules:

- Local operator authorization MUST be explicit.
- Missing subject/context MUST fail closed unless the request carries
  `localOperator=true`.
- Commands with `risk: "high"` or `risk: "destructive"` SHOULD require an
  explicit local confirmation flag even in local operator mode.
- Runtime execution with `agentId`, `RAVI_CONTEXT_KEY`, or a scoped context
  MUST NOT silently fall back to local operator.

## Risk Semantics

Risk classes are semantic review hints for providers, doctor, and operators.
They are not grants.

- `low`: read-only or deterministic local projection with no sensitive output.
- `medium`: local state mutation, bounded sync, or non-destructive route/session
  changes.
- `high`: external side effects, message delivery, credential access, provider
  calls, or sensitive data disclosure.
- `destructive`: delete, revoke, disable, prune, bulk write, irreversible
  mutation, or action that can strand runtime authority.

Commands that send messages, change routes/sessions, mutate credentials, touch
external providers, or run user-provided code MUST NOT be `risk: "low"`.

## Migration Rules

The migration from open-scope heuristics to explicit access metadata MUST be
domain-by-domain.

Recommended order:

1. Add the decorator and registry plumbing.
2. Annotate obvious read-only false positives first.
3. Annotate and gate high/destructive mutations next.
4. Convert doctor from heuristic warning to metadata coverage gate.
5. Remove reliance on open-scope mutation heuristics.

During migration, a command that looks mutating and lacks `@CommandAccess` MUST
remain visible in doctor output. After migration, any non-CLI-only command that
lacks `@CommandAccess` MUST fail the relevant quality gate.

## Prohibited Patterns

- Do not solve missing metadata by marking everything `@Scope("admin")`.
- Do not add a central static table detached from the decorated command method
  unless it is generated from the registry.
- Do not encode grant tuples or REBAC relation names in `@CommandAccess`.
- Do not let the SDK or tool gateway infer mutation risk from command names
  after metadata exists.
- Do not expose command input to providers without explicit selection and
  redaction.
- Do not let direct local CLI behavior define runtime agent authorization.

## Acceptance Criteria

- Public CLI commands expose command access metadata in the registry.
- Mutating commands produce provider-runtime requests before side effects in
  runtime/tool/gateway execution paths.
- Direct local CLI without principal uses explicit local-operator mode only.
- `ravi doctor --domain permissions` reports missing command access metadata
  and can distinguish missing metadata from intentionally read-only commands.
- Adding a new public mutating command without `@CommandAccess` fails tests or
  doctor checks.
