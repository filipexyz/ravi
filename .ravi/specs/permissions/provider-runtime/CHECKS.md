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

- `X=a#b bash -c id` and `python3 -W ignore#x -c code` MUST be refused,
  including through sudo. URL fragments and real word-start comments MUST
  preserve command boundaries. `echo x#y > .codex/config.toml` MUST retain its
  provider-settings write check.
- Piped bare interpreters with trailing comments, descriptor duplication,
  output/clobber/combined redirects or leading assignments MUST be refused;
  a real file-script argument MUST retain the documented executable boundary.
- PR #776 regression: `python3 -u`, `python3 -`, `python3 -I -`,
  `node --no-warnings`, `node --input-type=module -`, `perl -w`, `ruby -`,
  and `php -d x=1` as pipe receivers MUST fail in `checkDangerousPatterns`,
  `parseBashCommand` and the actual PreToolUse hook. Each MUST be tested alone,
  with `2>/dev/null`, with a leading `FOO=1`, and with both decorations.
  `python3 script.py`, `python3 ./a.py arg`, `node build.js`, and
  `node --no-warnings build.js` MUST continue passing.
- Option operands MUST NOT be mistaken for script files. Unknown flags,
  interactive modes, dynamic/glob/brace script words, stdin aliases and a
  filename after an explicit stdin marker MUST fail closed.
- PR #784 independent review regressions: `python3 /dev/fd/3 3<&0` and
  `| # comment` followed by `python3 -u` on the next line MUST be denied in both
  parser entry points and the actual hook. Cover arbitrary descriptor numbers,
  `/proc/**/fd/N`, stdout/stderr aliases, multiple leading comment lines and a
  real `python3 script.py` receiver after comments that still passes.
- Single-quoted substitution/backtick/process/heredoc text and escaped dollar
  or backtick in double quotes MUST pass in JSON and rg/grep arguments.
- Active substitutions outside and inside double quotes MUST fail, including
  line continuations, nested quote text and escaped backslash parity.
- Actual heredocs (even with quoted delimiters), here-strings and process
  substitutions MUST fail. Literal operator text MUST NOT create a pipeline.
- Quoted/escaped executable names, inline flags and piped interpreter receivers
  MUST retain their refusals, including with wildcard executable grants.
- Quote concatenation, backslashes inside single quotes, comments after escaped
  whitespace, command boundaries after comments and quoted newlines MUST be tested.
- Harmless printf fixtures MUST compare actual Bash output with the guard's
  expansion classification when `/bin/bash` is available.
- Real Bash comparisons MUST include nested and unquoted substitutions, escaped
  metacharacters, and heredocs with bare, quoted and escaped delimiters. A literal
  heredoc body does not make the heredoc operator permitted by this policy.
- Hook tests MUST demonstrate that named-executable grants permit literal search
  arguments, do not permit a later shell, and still permit interpreter file
  scripts: this last case documents the explicitly open capability boundary.

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
bun test src/bash/provider-config-writes.test.ts src/bash/parser.test.ts src/bash/hook.test.ts
bun test src/cli/commands/permissions.test.ts
bun test src/runtime/runtime-request-context.test.ts
bun test src/cli/commands/agents.test.ts
ravi doctor --domain permissions --json
```
