---
id: permissions/cli-command-access
title: "CLI Command Access Checks"
kind: capability
domain: permissions
capability: cli-command-access
---

# CLI Command Access Checks

## Static Registry Checks

- Build the CLI registry and assert every non-CLI-only public command has
  `access.kind`, `access.resource`, `access.action`, and `access.risk`.
- Assert `access.kind` is only `read` or `mutate`.
- Assert `access.risk` is only `low`, `medium`, `high`, or `destructive`.
- Assert commands matching mutating verb heuristics are not silently accepted
  without `@CommandAccess`.
- Assert commands with `risk: "high"` or `risk: "destructive"` are not exposed
  as unreviewed open-scope mutations.

## Provider Runtime Checks

- Runtime/tool/gateway command execution with `agentId` or context MUST call
  the Permission Provider Runtime before command side effects.
- Command execution MUST first check the semantic capability declared by
  `@CommandAccess`, for example `read:tasks.profiles:list` for
  `@CommandAccess({ kind: "read", resource: "tasks.profiles", action: "list" })`.
- Command execution SHOULD accept `<kind>:<resource>:*` as a resource-level
  wildcard and MAY accept `<kind>:<resource>.<action>:*` only as a transition
  alias.
- Legacy `execute:group:<group>_<command>` and `execute:group:<group>` MUST
  remain covered by tests while migration is active, but new docs and agent
  recommendations SHOULD use semantic `read/mutate` capabilities.
- Missing subject/context MUST deny unless `localOperator=true`.
- Runtime execution MUST NOT use direct local operator fallback.
- Provider requests generated from CLI commands MUST include command group,
  command name, access metadata, canonical principals, and selected redacted
  input only.
- Provider requests MUST NOT include context keys, credentials, bearer tokens,
  cookies, secret env values, or arbitrary unredacted payloads.

## Doctor Checks

`ravi doctor --domain permissions` SHOULD report:

- missing command access metadata by command id;
- mutating heuristic candidates that remain unclassified;
- commands whose `@Scope("open")` conflicts with high/destructive risk;
- commands whose metadata marks `kind: "read"` but whose name/action is likely
  mutating;
- commands whose metadata allows local operator for high/destructive risk
  without an explicit confirmation requirement.

The production target is:

```text
permissions.command_access.missing_public = 0
permissions.command_mutation_unclassified = 0
permissions.command_access.open_high_risk = 0
```

## Regression Tests

- Add unit tests for the decorator metadata and registry snapshot.
- Add doctor tests for missing metadata, false-positive read annotations, and
  high/destructive open-scope conflicts.
- Add runtime/tool-export tests proving provider-runtime is called before a
  mutating command is executed under context.
- Add command-access tests proving semantic `read/mutate` capabilities allow,
  semantic resource wildcard allows, dotted transition alias allows, and legacy
  `execute:group` fallback still works.
- Add local-operator tests proving direct terminal mode is explicit and never
  used for runtime contexts.
