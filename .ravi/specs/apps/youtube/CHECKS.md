# YouTube Ravi App / CHECKS

## Checks

- Manifest validation MUST pass with exactly one `youtube` app and zero errors
  or warnings after it declares
  `context.allow: ["execute:group:yt"]`.
- The public `ravi youtube` route and explicit `ravi apps run youtube` fallback
  MUST resolve the same declared operation and launch the same `ravi yt`
  implementation command.
- No CLI operation command may begin with the dynamic prefix `ravi youtube`.
- UI, generic SDK, runtime tool, and automation adapters MUST call the App
  Router rather than execute a separate YouTube implementation.
- In runtime context, read operations MUST require `use app:youtube`; mutating
  operations MUST require `execute app:youtube`.
- Runtime dispatch MUST issue a fresh `app:youtube` child context whose
  capabilities are no broader than `execute:group:yt`. Child issuance failure
  MUST start no CLI process.
- The launched CLI MUST receive only the child `RAVI_CONTEXT_KEY` as Ravi
  identity and MUST NOT receive the parent key or synthetic agent/session
  identity variables.
- The focused client, app, and CLI suites MUST pass without network access or a real credential.
- `yt health --json` MUST pass metadata-only with `authenticated=false` and `externalCheckPerformed=false`.
- `yt info --json` with isolated empty state MUST fail before any Google request with an actionable missing-credential error.
- Generated command and SDK artifacts MUST remain current, and typecheck, build, Biome, and diff checks MUST pass.
- Static preservation checks MUST find no SDE dependency, legacy credential path, monetary scope, or monetary metric in implementation code.

Run from the repository/worktree root:

```bash
bun run gen:commands
bun test src/apps/youtube src/cli/commands/youtube.test.ts
bun src/cli/index.ts apps check youtube --json
bun src/cli/index.ts youtube health --json
bun src/cli/index.ts apps run youtube health --json
bun src/cli/index.ts yt --help
bun src/cli/index.ts yt health --json
bun run sdk:generate
bun run sdk:check
bun run typecheck
bun run build
bunx biome check src/apps/youtube src/cli/commands/youtube.ts src/cli/commands/youtube.test.ts
```

Credential-failure regression with no real backend or network:

```bash
RAVI_STATE_DIR=/tmp/ravi-youtube-empty bun src/cli/index.ts yt info --json
```

Expected: exit 1 with an actionable `YouTube credential unavailable` message before any Google request. Do not add a token to make this check pass.

Static preservation checks:

```bash
git diff --name-only origin/dev...HEAD
rg -n "sde|youtube-token|youtube-credentials" src/apps/youtube src/cli/commands/youtube.ts
rg -n "yt-analytics-monetary|estimatedRevenue|grossRevenue" src/apps/youtube src/cli/commands/youtube.ts
```

Expected: no SDE dependency/token path and no monetary scope/metric in implementation code. Mentions in tests/specs may only assert their absence.
