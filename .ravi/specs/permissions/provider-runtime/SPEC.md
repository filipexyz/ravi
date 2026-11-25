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

## Runtime Tool Calls

- On a runtime with host session hooks (Claude Code), every tool call MUST be
  authorized as `use:tool:<name>`, by the name the runtime reports for the call.
- The check MUST NOT consult a list of known tool names. A name no list holds
  MUST be denied unless the turn holds a matching capability. This covers tools
  of MCP servers the runtime loaded from its own configuration or from a plugin
  (`mcp__<server>__<tool>`), the MCP resource readers (`ListMcpResourcesTool`,
  `ReadMcpResourceTool`, `ReadMcpResourceDirTool`) and tools a newer runtime
  version adds.
- A capability matches the reported name exactly, as `*`, or as a prefix when
  it ends in `*`; there is no other pattern, apart from the two names of the
  subagent tool below. `use:tool:mcp__<server>__*`
  therefore grants every tool whose name starts with `mcp__<server>__`: the
  tools of the server under that name, and of any server whose name starts
  with `<server>__`. The grant is a name prefix, not a server identity.
- Server names come from Ravi's MCP registry (`mcp`), not from the runtime's
  configuration. A registered name matches `^[a-z][a-z0-9-]{0,23}$` and holds
  no underscore, so `use:tool:mcp__<server>__*` reaches no other registered
  server. Host server names (`spec`) and `ravi` are reserved and cannot be
  registered.
- `use:tool:mcp_*` (written for Pi's `mcp_tools` and `mcp_call`) is also a
  prefix of every `mcp__<server>__<tool>` name and grants all of them.
- The MCP resource readers are not per-server: a grant of one reader covers
  the resources of every server the session started.
- The subagent tool goes by two names and the two are one tool. Claude Code
  reports it as `Agent`; the registry, its tool groups and the grants stored
  before the rename say `Task`, and an older Claude Code reports `Task`. A grant,
  a tool group that lists either name and a `deny_use` entry under one name MUST
  apply to a call reported under the other, and an explicit grant under one name
  MUST still allow what a `deny_use` pattern withholds from a call under the
  other. This is the only exception to exact name matching, and it covers
  `tool` objects only: `TaskOutput`, `TaskStop` and the task-list tools
  (`TaskCreate`, `TaskUpdate`, ...) are tools of their own, and an agent or a
  session called `Agent` is not the tool. The pairs live in
  `TOOL_NAME_EQUIVALENTS` (`src/cli/tool-registry.ts`); a runtime that renames
  another tool adds its pair there.
- A governed chat composes a contact's turn from the agent ceiling and the
  contact's chat grants (`buildEffectiveCapabilities`): it keeps a grant that no
  deny overlaps and drops the whole grant that one does. The overlap MUST see
  both names of the subagent tool: a deny of one name overlaps a grant of the
  other, and two trailing patterns that each reach a different name of the tool
  (`Ag*` and `Task*`) overlap. The rule stays the fail-closed one of every other
  tool: a deny of the subagent drops a prefix grant that covers it (`Task*`),
  the other `Task` tools with it, and a deny wins over an explicit grant of
  either name. The composition proposes only the grants the branches hold, so a
  prefix on each branch that reaches a different name (`Task*` for the agent,
  `Ag*` for the contact) intersects to nothing and the contact has no subagent;
  exact names intersect, so grant the exact name.
- Spec mode MUST block the subagent tool under both of its names.
- A tool call without a tool name MUST be denied.
- The tool and Bash permission hooks MUST turn their own failure into a denial.
  Claude Code ignores a PreToolUse hook that throws and runs the tool, so an
  exception while reading state or recording a denial would otherwise allow
  the call. The same holds for the hooks that ask a person for approval
  (`mcp__spec__exit_spec_mode`, `ExitPlanMode`, `AskUserQuestion`): a failed
  approval request MUST deny the call, not let it run unapproved
  (`runtime/providers/claude-code`).
- When the agent is known, the denial record of an MCP tool MUST carry the
  server name and source the runtime reported, as untrusted text.
- Tools of an in-process MCP server that Ravi attaches to the session itself
  are host tools: the agent setting that attaches the server is the grant, and
  the tool check MUST skip them, on every turn of that session, a turn that
  holds no capabilities included. Today the only such server is `spec`,
  attached for spec-mode agents. A host server that forwards calls to servers outside
  the Ravi process is not a host tool source and MUST NOT be declared as one.
- Gateway facades are such forwarding servers: in-process servers Ravi attaches
  to a Claude session to expose registered MCP servers (`mcp`, Claude
  Facade). Their names MUST NOT enter the host server list; the hook receives
  them in a separate gateway list. Their tools MUST be checked by name like any
  other tool, and the gateway authorizes the call again (`authorizeMcpUse`).
  Host and gateway names MUST be disjoint.
- Provenance of unregistered servers. For an `mcp__` name that is not a host
  tool:
  - when the runtime reports `mcp_server`, the call MUST be denied unless
    `source` is `sdk` and `name` is in the session's gateway list. The denial
    MUST say that the server (name and source, as untrusted text) is not
    registered in Ravi, and MUST hold even when the turn holds `use:tool:*`;
  - when the runtime reports no `mcp_server`, a name under a host or gateway
    prefix falls through to the name check (the gateway re-authorizes a
    gateway tool), and any other `mcp__` name MUST be denied;
  - a provenance denial is recorded against the server
    (`use mcp_server:<reported name>`, with the tool, the source and code
    `not_registered` in the detail), not against the tool, because no tool
    grant can resolve it. Without an agent identity only the audit event is
    emitted;
  - a call that passes these rules is then checked by name as above.
- The host-tool exemption MUST be decided from the server provenance the
  runtime reports with the call (`mcp_server.source` equal to `sdk` and
  `mcp_server.name` equal to a name the session declared). It MUST NOT be
  decided from the tool-name prefix: a configured server may reuse a host
  server's name, and both then answer under `mcp__<name>__`. The provenance
  exempts only a name that starts with `mcp__`: a built-in tool name MUST be
  checked whatever arrives beside it. A call without
  provenance MUST be checked like any other tool; when its name is under a
  host server's prefix, the denial SHOULD say that the runtime reported no
  server (a Claude Code too old to report it).
- Claude Code may load MCP tool definitions on demand through `ToolSearch`,
  host tools included. `ToolSearch` is checked like any tool, so a turn
  without `use:tool:ToolSearch` may be unable to reach an MCP tool it is
  otherwise allowed to call.
- The Bash permission hook MUST keep its `Bash` matcher. Claude Code delivers
  the shell command of its `Monitor` tool to `Bash`-matched hooks as a Bash
  call; a hook without a matcher sees that call only as `Monitor`.
- This check is on the call. Which servers a runtime may start is a separate
  rule: every runtime MUST load registered servers only (`mcp`,
  Registered-Only Loading Per Runtime). Claude Code starts with strict MCP
  configuration and fails a turn whose `system/init` lists a server Ravi did
  not declare. Codex starts with each server of its own configuration
  disabled and fails closed when one is still reported or an MCP tool call
  item appears. Grok's MCPTool class is always refused, whatever the grants
  say. Pi has no native MCP tools, and any `mcp__*` tool name is denied there.
- Pi, Codex and Grok reach registered servers through `ravi mcp tools` and
  `ravi mcp call`, which check the same `use:tool:mcp__<server>__<tool>`
  capability in the daemon.
  The runtime bootstrap floor grants the two command actions
  (`read:mcp.tools:list`, `mutate:mcp.tools:call`), `read:mcp.skills:read`
  (a pinned skill's stub), and `read:mcp.calls:list` and
  `mutate:mcp.calls:cancel` (a background call's own commands, narrowed per
  turn to the session's calls on servers and tools that turn may use), and
  no other `ravi mcp` command, so an agent reaches a registered server on
  every runtime by the same two decisions: the operator's attachment and the
  tool grant.

## Prompt Text

- Text in a prompt MUST NOT make the runtime read a file on its own. Claude
  Code expands `@path` in prompt text into the file's content before any tool
  call, so no PreToolUse hook sees that read, and Ravi prompts carry text
  typed by other people in a chat.
- Every Claude Code process Ravi starts MUST carry
  `CLAUDE_CODE_DISABLE_FILE_MENTIONS=1`, over any value the agent's
  environment holds: session turns (every path of
  `buildClaudeCodeEnvironment`), the memory agent, and remote spawns over SSH
  and NATS, where the value is a constant on the remote command line or in the
  spawn payload and does not depend on the credential opt-in.
- With the switch a mention stays text. A file reaches the model only through
  a tool call, which Runtime Tool Calls covers.
- The switch MUST NOT be replaced by the Agent SDK's `verbatimPrompts` without
  a live check: that option also drops the context Claude Code attaches at the
  start of a turn (skill and tool listings).
- `@AGENTS.md` imports inside `CLAUDE.md` are instructions loading, not prompt
  mentions, and MUST keep working with the switch.

## Provider Settings File Writes

- File-writing tools and shell output redirects MUST require
  `execute:executable:*` or `admin:system:*` when their destination is runtime
  provider configuration (`.claude`, `.codex`, `.pi`, `.grok`, or `.mcp.json`). `use:tool:Write`
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

- An effective `execute:executable:*` grant MUST authorize arbitrary shell
  forms, including substitutions, heredocs, inline interpreters and shell/source
  commands. The host MUST resolve that grant through the same context-aware
  evaluator as ordinary executable authorization, before applying the restricted
  syntax subset. A profile label or a parent agent's unrestricted ceiling MUST
  NOT substitute for that effective decision.
- Issued child limits, unresolved-actor snapshots, user overlays, relay/turn
  narrowing and live executor reductions MUST remain effective in both the SDK
  hook and native runtime approval path. Native adapters MUST preserve context
  metadata when evaluating Bash. No new grant or approval is implied.
- Arbitrary execution MUST NOT skip Bash tool authorization, environment identity
  checks, Ravi session/command authorization or skill gates. Static skill discovery
  MAY accept inline code without treating it as permission proof; unsupported
  discovery MUST remain unknown rather than an empty executable list, preserving
  conservative text/group gates. Static gates do not inspect arbitrary code inside
  scripts or interpreter strings; actual Ravi requests still authorize at the
  authenticated gateway.
- Automatic Ravi skill inference MUST use command positions and quote boundaries,
  including inside active substitutions. Literal arguments and comments MUST NOT
  become executable evidence because another region has active shell syntax.
  Incomplete executable hints MUST NOT hide Ravi in nested, double-quoted,
  backtick or process substitutions and pipelines. A here-document body is stdin
  and MUST NOT be read as command lines: a quoted delimiter makes the body
  literal, and an unquoted delimiter leaves only its command substitutions
  active. The delimiter word MUST NOT be taken as the executable. Lines after a
  here-document redirect with no terminator line MUST stay readable as commands.
  `<<` inside `((...))` or `$((...))` is an arithmetic shift and MUST NOT open a
  here-document. When a delimiter word cannot be followed, the lines after that
  redirect MUST stay readable as commands; discovery MAY then over-report and
  MUST NOT hide a command line.
  Explicit configured `commandRegex` rules retain their raw-text contract. This
  discovery is bounded: script contents, interpreter/eval strings and dynamic
  command names are not evaluated, and no discovery result grants permission.
- The syntax restrictions below apply to contexts without effective arbitrary
  execution. Policy refusals MUST identify `shell_syntax` and a stable rule,
  without inventing a missing executable capability from the first command token.
  Actual missing executable grants MUST remain distinct. Every denied decision
  MUST be denied by the SDK hook, including new policy categories.
- Dangerous-pattern checks MUST distinguish active shell syntax from literal
  arguments. Ordinary single-quoted data, escaped metacharacters and inert
  operators inside double quotes MUST NOT be rejected just for containing a
  substitution, heredoc or pipe token. JSON, regex and code arguments are data
  according to shell quoting, not according to their intended destination.
- Analysis and authority are separate. The parser MUST return every command
  the shell would run with its typed path and origin (`segment`, `substitution`,
  `process_substitution`, `heredoc`, `launcher`), or fail with the named error
  `unknown_parse`. The policy decides. `unknown_parse` MUST be refused as
  `shell_syntax` / `unknown_parse`, never as a missing executable permission.
- Dollar-paren and backtick substitutions (also inside double quotes), process
  substitutions and the substitutions of an unquoted here-document body are
  commands: each MUST be authorized by its own grant and the policy below. A
  quoted here-document body (`<<'EOF'`, `<<"EOF"`, `<<\EOF`) is data and MUST NOT
  yield commands. A here-document without a terminator, a `case` inside a
  substitution, a dynamic command word and `$'...'` quoting are `unknown_parse`.
- Executable identity MUST use the real path, never the basename. A
  path-qualified command MUST resolve (symlinks followed) to an existing
  executable under a trusted root (system and package-manager prefixes, the
  host PATH directories, `RAVI_BASH_TRUSTED_EXECUTABLE_ROOTS`); otherwise it is
  `untrusted_executable_path`. A relative path needs a fixed working directory
  (no `cd`/`pushd`/`popd` in the command). A bare name resolves through the host
  PATH; a cwd-relative PATH entry is untrusted. A binary whose real name is a
  shell or interpreter under another name is `indirect_execution`. The always
  allowed `ravi` name gets the same identity check.
- Launchers that exec another command (`xargs`, `find -exec/-execdir/-ok`,
  `env`, `timeout`, `nice`, `nohup`, `sudo`, `command`, `builtin`, `stdbuf`,
  `setsid`, `caffeinate`, `time`) MUST expose their payload as a `launcher`
  command checked like any other. A shell or interpreter payload, and every
  shell-string launcher (`parallel`, `sem`, `watch`, `su`, `runuser`,
  `script`), is `shell_launcher` and needs `execute:executable:*`, which the
  bootstrap floor does not have. A payload taken from input (`{}`) or an
  unknown launcher option is `unknown_parse`.
- Changing which program runs is `execution_override`: assigning `PATH`,
  loader (`LD_*`, `DYLD_*`), shell startup, pager/editor or `GIT_*` command
  variables in any form (prefix, `export`, `env`, `for`), and git options that
  run a program (`-c` outside a small display/identity allowlist,
  `--config-env`, `--exec-path`, `rebase -x`, `bisect run`, `submodule foreach`,
  `difftool -x`, `--upload-pack`/`--receive-pack`, `archive --exec`,
  `filter-branch`, `clone --template`).
- An assignment whose value is quoted (`X="1" cmd`) is still an assignment: the
  command after it MUST be checked.
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
  script argument in a restricted context.
- The bounded scanner MUST refuse unterminated quotes/escapes and unsupported
  ANSI-C / locale quoting rather than assume them safe. It is not a shell AST.
  `stripShellQuoting`, used for identity text checks, MUST NOT be used as the
  syntax view: removing delimiters loses the distinction between data and code.
- The guard is an accident-prevention layer for directly visible command syntax,
  not a sandbox or a proof of the effects of an allowed executable. Interpreter
  scripts in files are a KNOWN OPEN vector; no file-content inspection is added.
  The bootstrap floor keeps this vector by design: `bun <file>` and git hooks or
  repository config written with the file tools run arbitrary code. Closing it
  is a profile decision (drop `bun`/`git` or file writes from the floor), not a
  syntax rule.
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
