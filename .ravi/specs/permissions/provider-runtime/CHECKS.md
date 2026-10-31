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
