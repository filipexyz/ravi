# Permission Provider Runtime / CHECKS

## Static Checks

- Production authorization call sites use `src/permissions/provider-runtime.ts`.
- `provider-runtime.ts` does not import retired permission engines or direct
  capability evaluators.
- App routers do not execute app permission providers directly.
- Skills and specs document `ravi permissions status/check/materialize` and
  `ravi agents permissions`.

## Runtime Checks

- No-subject/no-context without `localOperator=true` denies.
- Explicit local operator allows through the `operator-control` provider.
- `operator-control` appears before `context-capabilities` in the default
  authorization provider chain.
- `operator-control` has no capability materializer.
- Context snapshots authorize only through `context-capabilities`.
- Agent runtime config materializes through `agent-default-capabilities`.
- Agent identity materializes through `agent-identity-permissions`.
- Bootstrap agent and automation contexts can run the read-only Codex Bash
  policy hook without receiving the broader context command group.
- Contact permission tags materialize through `contact-policy-permissions`.
- External resolved contact turns use `authorityMode=agent-identity` and do
  not require contact/surface capabilities for bootstrap tool authority.
- Agent-identity denials resolve to `agent:<executorAgentId>` as the recurring
  target.
- Default agent visibility migration yields `view agent:*`.
- Router database bootstrap MUST preserve retired permission-provider tables
  and their rows during mixed-version process transitions.
- Managed updates MUST stop channel intake before restarting the daemon,
  restore only processes that were previously online, and verify their final
  status.

## Commands

Quoting regressions (`bun test src/bash/`):

- Effective wildcard execution admits substitutions, heredocs, inline Python,
  shell/source commands and compound `cd` through both the SDK hook and native
  runtime authorization, without new approvals.
- The indirect/unsupported shell forms remain denied to named-executable, narrowed child,
  unresolved-actor, relay/turn-narrowed and contact-limited contexts, including
  under a full-access executor. Live executor reductions take effect on the next
  check. Ordinary `cd` chains remain admissible with their named grants.
  Tool, environment, session and skill authorization remain separate.
- Syntax refusals emit `shell_syntax` with a stable rule and sanitized command
  length, without a false missing-capability row or executable name. SDK hooks
  deny that category. Native skill discovery retains inline executable gates and
  conservative text/group gates on unsupported syntax.
- `CI840 quote-aware command discovery` in `src/runtime/skill-gate.test.ts`
  covers mixed literal Ravi text plus active unrelated expansion, actual nested
  substitutions/pipelines, quoted command words, configured raw-text rules and
  native skill delivery/retry. Literal-only mentions MUST NOT load a skill;
  named-executable contexts MUST remain restricted. The same block covers
  here-documents: a body under a quoted delimiter (`<<'EOF'`, `<<"EOF"`,
  `<<\EOF`) MUST NOT load a skill, a body under an unquoted delimiter MUST gate
  only its active substitutions, the delimiter MUST NOT hide the command on its
  own line, and lines with no terminator MUST still be read as commands. A `<<`
  that is an arithmetic shift (`((...))`, `$((...))`, a subscript or an
  expansion offset) or whose delimiter word cannot be followed MUST NOT hide
  the Ravi line that follows it.
- The remaining syntax-refusal checks below use restricted contexts. The parser
  defaults remain strict; its explicit inline-code discovery mode is not an
  authorization decision.
- `X=a#b bash -c id` and `python3 -W ignore#x -c code` MUST be refused,
  including through sudo. URL fragments and real word-start comments MUST
  preserve command boundaries. `echo x#y > .codex/config.toml` MUST retain its
  provider-settings write check.
- Piped bare interpreters with trailing comments, descriptor duplication,
  output/clobber/combined redirects or leading assignments MUST be refused;
  a real file-script argument MUST retain the documented executable boundary.
- Single-quoted substitution/backtick/process/heredoc text and escaped dollar
  or backtick in double quotes MUST pass in JSON and rg/grep arguments.
- Active substitutions outside and inside double quotes MUST expose their
  command (origin `substitution`), including line continuations, nested quote
  text and escaped backslash parity; an unauthorized inner command is denied as
  a missing executable grant naming it.
- Quoted here-document bodies MUST yield no command; unquoted bodies expose only
  their substitutions (origin `heredoc`). Process substitutions expose their
  command. Literal operator text MUST NOT create a pipeline.
- `src/bash/launcher-realpath-policy.test.ts` MUST keep:
  `bootstrap_denies_shell_launchers` (xargs, find -exec, env, timeout, nice,
  nohup, parallel, watch refuse a shell/interpreter payload under bootstrap even
  when the launcher is granted), `realpath_not_basename_defeats_copied_binary`
  (copied shell, symlinked shell, copy-then-run, relative path and PATH
  override), `heredoc_quoted_body_is_not_commands`,
  `substitution_and_redirect_allowed_when_command_authorized` (`printf
  "$(date)"`, `echo $(git ...)`, `ls | sort > out` with Write, `diff <(...)`),
  `unknown_parse_fails_closed_with_named_error`, and regressions for keywords
  (#813), disguised substitutions (#767/#776), quoted assignment values and env
  spoofing inside substitutions.
- Quoted/escaped executable names, inline flags and piped interpreter receivers
  MUST retain their refusals for named-executable grants.
- Quote concatenation, backslashes inside single quotes, comments after escaped
  whitespace, command boundaries after comments and quoted newlines MUST be tested.
- Harmless printf fixtures MUST compare actual Bash output with the guard's
  expansion classification when `/bin/bash` is available.
- Real Bash comparisons MUST include nested and unquoted substitutions, escaped
  metacharacters, and heredocs with bare, quoted and escaped delimiters. The
  analyzer MUST report a nested command exactly when Bash executed one.
- Hook tests MUST demonstrate that named-executable grants permit literal search
  arguments, do not permit a later shell, and still permit interpreter file
  scripts: this last case documents the explicitly open capability boundary.

Runtime tool call regressions (`src/bash/hook.test.ts`,
`src/runtime/host-hooks.test.ts`, `src/permissions/tool-name-equivalence.test.ts`):

- An MCP tool is denied without a matching capability and allowed by its exact
  name, by `mcp__<server>__*` and by `*`. The pattern is a name prefix: it
  does not cover `mcp__github_enterprise__*`, and it does cover a server
  named `github__admin`.
- The MCP resource readers and names outside the built-in registry (`Monitor`,
  `CronCreate`, `RemoteTrigger`, `Workflow`, `ScheduleWakeup`, an invented name)
  are denied without a matching capability.
- A call without a tool name, and an MCP call without agent identity, are
  denied.
- A tool or Bash permission hook whose check throws denies the call.
- A `spec` tool runs without the tool capability only when the runtime reports
  `source: "sdk"` and the session declared `spec`. The same name from any other
  source, a missing or malformed server report, and an undeclared in-process
  server are checked. A host name denied without a server report says so.
- The registered PreToolUse chain attaches `spec` as a host server only for a
  spec-mode agent.
- A grant of `use:tool:Task` allows a call reported as `Agent`, and a grant of
  `use:tool:Agent` allows a call reported as `Task`. So does a tool group that
  lists `Task` and a prefix pattern that matches either name, and a `deny_use`
  entry under one name withholds the other. An explicit grant under one name
  still allows what a `deny_use` pattern withholds from a call under the other.
  The same holds on a live executor ceiling and on a user-overlay turn. A grant
  of one name does not cover `TaskOutput`, `TaskStop`, `TaskCreate` or `Agents`,
  and an agent or a session object called `Agent` is not the tool. Each part
  has a test that fails when the part is reverted (the evaluator, the registry
  pair, the tool group, the deny, the explicit-grant exception, the tool-only
  rule and the spec-mode block).
- With spec mode on, the registered PreToolUse chain blocks the subagent tool as
  `Task` and as `Agent` and leaves `TaskOutput`, `TaskStop`, `Read` and `Grep`
  alone; with spec mode off, a grant of every tool passes both names.
- Live check, when the Claude Agent SDK is upgraded: in a session with a
  project `.mcp.json` server and an in-process server of the same name, the
  PreToolUse input for each `mcp__*` call carries `mcp_server` with the right
  source, a `Monitor` shell command reaches the `Bash`-matched hook, and a
  PreToolUse hook that throws still lets the tool run (the reason the hooks
  catch their own failures). When a configured server exposes the same full
  tool name as a host tool, the call runs the host tool and reports
  `source: "sdk"`. With every tool denied, a prompt holding `@/abs/path` does
  not put the file in the model's context, `@AGENTS.md` in `CLAUDE.md` still
  loads, and `@server:uri` does not make the runtime read the MCP resource
  (the server sees no read). Last run on Claude Code 2.1.323 (2026-11-24).

Prompt text regressions (`src/runtime/claude-provider.test.ts`,
`src/remote-spawn.test.ts`, `src/remote-spawn-nats.test.ts`,
`src/hooks/pre-compact-spawn-env.test.ts`):

- `buildClaudeCodeEnvironment` returns `CLAUDE_CODE_DISABLE_FILE_MENTIONS=1` on
  every path (plain, managed auth, model broker, no input) and over a caller
  value of `0` or empty.
- The SSH remote command exports the switch whatever the caller's env says;
  the NATS spawn payload carries it with and without the credential opt-in.
- The memory agent is spawned with the switch set to `1` while the daemon env
  holds `0`: the fake Claude Code records the value it received.

Provider settings regressions (`src/bash/provider-config-writes.test.ts`):

- A symlink `nested/innocent -> .codex` cannot be written through
  `cd nested && echo '{}' > innocent/config.toml` by an echo/cd writer.
- Redirects check both successful and failed `cd` outcomes across `&&`, `||`
  and `;`, including redirects placed before the cd executable.
- A symlink followed by `..` resolves physically for file tools and shell
  redirects; dangling file links and cyclic links cannot bypass the guard.
- Safe writes such as `cd nested && echo ok > notes.txt` remain allowed.
- Variable/glob/brace targets, multiline comments/continuations, pipelines,
  subshells and state-changing builtins cannot turn an unresolved destination
  into a permission allow.

```bash
bun test src/permissions/provider-runtime.test.ts
bun test src/permissions/tool-name-equivalence.test.ts
bun test src/bash/provider-config-writes.test.ts src/bash/parser.test.ts src/bash/hook.test.ts
bun test src/runtime/host-hooks.test.ts
bun test src/runtime/claude-provider.test.ts src/remote-spawn.test.ts src/remote-spawn-nats.test.ts
bun test src/hooks/pre-compact-spawn-env.test.ts
bun test src/cli/commands/permissions.test.ts
bun test src/runtime/runtime-request-context.test.ts
bun test src/cli/commands/agents.test.ts
ravi doctor --domain permissions --json
```
