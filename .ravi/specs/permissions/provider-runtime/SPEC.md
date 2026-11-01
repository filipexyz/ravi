---
id: permissions/provider-runtime
title: "Permission Provider Runtime"
kind: capability
domain: permissions
capability: provider-runtime
capabilities:
  - provider-runtime
  - authorization
  - providers
  - audit
tags:
  - permissions
  - provider-runtime
applies_to:
  - src/permissions
  - src/runtime
  - src/apps
  - src/bash
  - src/sdk/gateway
  - src/cli
owners:
  - ravi-dev
status: active
normative: true
---

# Permission Provider Runtime

## Intent

The Permission Provider Runtime is the only authorization surface in Ravi.

Ravi core owns authorization plumbing: context resolution, canonical
principals, provider registry, bounded execution, provider composition, audit,
and resource-visibility filtering. Domain policy lives in providers or in
provider-owned subject configuration.

## Default Providers

Required authorization providers:

- `operator-control`: explicit local operator control path.
- `context-capabilities`: checks already materialized runtime snapshots.

Required capability materializers:

- `runtime-bootstrap`
- `agent-default-capabilities`
- `agent-identity-permissions`
- `contact-policy-permissions`

## Rules

- Runtime code MUST call the provider-runtime facade for authorization.
- Runtime context creation MUST materialize subject capabilities through the
  registered materializer chain.
- Bootstrap agent and automation contexts MUST receive the exact read-only
  `read:context:codex-bash-hook` capability so Codex can enforce Bash policy;
  this MUST NOT grant the broader `execute:group:context` capability.
- `ravi permissions status/check/materialize` MUST remain inspection-only.
- `ravi permissions allow/deny/resolve` MUST be provider-owned orchestration
  only: they may create/update permission-scoped tags, write chat-scoped
  contact grants (`permission_contact_chat_grants`), attach global contact
  permission tags with `--force`, and ensure agent default capability
  ceilings, but MUST NOT write to a native permission graph.
- Agent authority changes MUST use provider-owned config, currently
  `agent.defaults.runtimePermissions` via `ravi permissions allow/resolve` or
  direct agent-only `ravi agents permissions`.
- The `agent.defaults.runtimePermissions` key is a compatibility storage name;
  the active materializer id is `agent-default-capabilities`.
- Stored profile `chat-only` is an explicit sentinel. `runtime-bootstrap` and
  `agent-identity-permissions` MUST suppress bootstrap (and any identity
  re-injection of `use:tool:*` / execute groups/executables) for that executor.
  `null` / absent / `none` remain the bootstrap floor.
- External shared-surface turns MUST use `agent-identity-permissions` as the
  production authority projection. Contact and chat principals remain
  provenance/invocation context, except in chats governed by chat-scoped
  contact grants, where `contact-policy-permissions` supplies the user overlay
  intersected with the agent identity (`permissions/user-overlay`).
- Denial resolution for `authorityMode=agent-identity` MUST apply recurring
  capability to `agent:<executorAgentId>`, not to `contact:<actorId>`, unless
  the denial came from the user overlay; then it MUST plan a chat-scoped
  contact grant plus the agent ceiling.
- Direct local management MAY be allowed only through the explicit
  `operator-control` provider.
- `operator-control` MUST support local requests only when the caller
  deliberately sets `localOperator=true`; missing subject/context is never
  enough to infer operator authority.
- `operator-control` MUST NOT materialize runtime capabilities for agents,
  contacts, chats, automations, sessions, or apps.
- A no-subject/no-context request without explicit operator-control intent MUST
  deny.
- Resource discovery is authorization. List/show/search surfaces MUST filter by
  provider-runtime visibility capabilities.
- Provider errors, timeouts, malformed output, and required provider denials
  MUST fail closed.
- Ordinary database initialization MUST NOT destructively drop retired
  permission-provider storage. Destructive cleanup requires an explicit
  offline migration after every managed Ravi process is on a compatible
  bundle.
- Updates that replace runtime code MUST stop channel intake before
  transitioning the daemon, restore only the managed processes that were
  running before the update, and verify that they return online.

## Provider Settings File Writes

- File-writing tools and shell output redirects MUST require
  `execute:executable:*` or `admin:system:*` when their destination is runtime
  provider configuration (`.claude`, `.codex`, `.pi`, or `.mcp.json`). `use:tool:Write`
  alone MUST NOT authorize that write. Case variants MUST also be protected on
  case-insensitive filesystems.
- Destination checks MUST resolve paths against the executing tool's working
  directory and follow symlinks before processing subsequent `..` components.
  Missing targets behind symlinks MUST NOT bypass the check. Cycles or unreadable
  path resolution MUST fail closed.
- Shell redirect checks MUST account for literal `cd` commands in a chain and
  for both success and failure of those commands. They MUST bound the number of
  candidate directories and symlink traversals and refuse on overflow.
- Shell syntax whose redirect destination or working directory cannot be proven
  by the supported parser subset MUST be refused for restricted writers. This
  includes dynamic destinations, subshells, pipelines, shell state mutations,
  multiline commands and unsupported expansions. Simple `cd nested && echo ok > notes.txt`
  SHOULD remain possible when all candidate destinations are safe.
- This pre-execution check is not a filesystem sandbox. Executables with their
  own write operations (for example `cp` or `tee`), hard-link aliases outside the
  protected paths, and filesystem changes between authorization and execution
  remain outside this path check. Executable grants MUST be reviewed with those
  limits in mind.

## Bash Syntax Guard And Executable Trust

- Dangerous-pattern checks MUST distinguish active shell syntax from literal
  arguments. Ordinary single-quoted data, escaped metacharacters and inert
  operators inside double quotes MUST NOT be rejected just for containing a
  substitution, heredoc or pipe token. JSON, regex and code arguments are data
  according to shell quoting, not according to their intended destination.
- Dollar-paren and backtick substitutions remain executable inside double
  quotes and MUST still be refused. Real process substitutions and heredoc /
  here-string operators MUST remain refused, including quoted heredoc delimiters.
- Literal masking MUST preserve token boundaries; quote removal MUST NOT join
  a literal dollar with a literal parenthesis into active syntax. Escapes inside
  single quotes are ordinary characters. Continuations outside single quotes
  MUST preserve detection of active substitutions split across lines.
- Executable and inline-flag checks MUST decode quoted/escaped words rather than
  delete their content. Quoting `bash`, `python3` or `-c` MUST NOT bypass the
  unconditional executable or inline-code checks. Active pipeline receivers
  MUST be checked independently of literal pipe characters in arguments.
- All shell token consumers, including output-redirect checks, MUST use the
  same word-start comment semantics: an unquoted mid-word `#` is data and MUST
  NOT hide later executables, inline flags or redirect targets. A real comment
  MUST still stop at the next newline.
- Piped-interpreter stdin detection MUST count command words, excluding leading
  assignments, comments, redirection operators, descriptors and destinations.
  These shell decorations MUST NOT make a bare interpreter appear to have a
  script argument, even when wildcard executable access is granted.
- The bounded scanner MUST refuse unterminated quotes/escapes and unsupported
  ANSI-C / locale quoting rather than assume them safe. It is not a shell AST.
  `stripShellQuoting`, used for identity text checks, MUST NOT be used as the
  syntax view: removing delimiters loses the distinction between data and code.
- The guard is an accident-prevention layer for directly visible command syntax,
  not a sandbox or a proof of the effects of an allowed executable. Interpreter
  scripts in files are a KNOWN OPEN vector; no file-content inspection is added.
  Granting `execute:executable:python3` can authorize a script with arbitrary host
  effects, even without `use:tool:Write` (the file may already exist).
- File-tool write grants and redirect checks govern those specific write paths;
  they do not constrain a process's own file/network/child-process operations.
  Session scope, issued contexts and approvals authorize Ravi-mediated actions,
  not every operation an allowed host process can perform. Approval of an
  executable MUST NOT be described as approval/validation of script content.
- Before claiming confinement of interpreter execution, a follow-up MUST define
  and test an enforced host sandbox or a trusted immutable entrypoint policy.
  Content-grep heuristics MUST NOT substitute for that boundary. This change
  MUST NOT expand capabilities, approvals or production permissions.
- Review principle shared with cron: an entry guard without reconciliation of
  already-admitted state leaves dead capability appearing active. A guard review
  MUST cover persisted/indirect paths, actual execution and truthful inspection,
  and explicitly register unsupported paths rather than claim they are protected.

## Operator Control Boundary

`operator-control` is a provider-runtime control-plane branch for operator
actions such as inspecting decisions, resolving denials, and applying
provider-owned profiles. It is not part of the agent identity execution branch.

The local implementation is intentionally narrow. A future remote management
plane MAY add an authenticated operator identity provider, but MUST keep the
same separation:

- operator authorization decides whether the human/operator can manage policy;
- agent identity authorization decides whether a runtime action may execute;
- short-lived runtime grants remain bounded to the target context or profile
  selected by the operator.

## Agent Visibility Migration

- DB initialization MUST ensure the default agent has provider-owned
  `view agent:*`.
- `agents create` under a runtime creator MUST persist
  `view agent:<created-id>` for that creator through provider-owned config.
- WhatsApp group creation with `--create-agent` MUST apply the same creator
  visibility rule.
- The migration MUST be idempotent and MUST NOT depend on removed command
  paths.
