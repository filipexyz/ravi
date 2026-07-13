# Google Business Profile Ravi App / CHECKS

## Checks

- Manifest validation MUST pass with exactly one `google-business-profile` app
  and zero errors or warnings.
- The focused client, app and CLI suites MUST pass without network access or a
  real credential.
- App health (`ravi apps check google-business-profile --json`) MUST be
  credential-free manifest validation and MUST NOT perform an authenticated
  request.
- Every command invoked without a configured credential MUST fail before any
  Google request with an actionable missing-credential error.
- Read, write and destructive operations MUST carry distinct `CommandAccess`
  declarations and manifest permissions; every mutation MUST require
  confirmation.
- Public commands MUST declare a concrete JSON return schema and MUST be
  generated into the TypeScript SDK; `sdk:check` MUST report no drift.
- Secret values (`clientSecret`, `refreshToken`, verification PINs) MUST NOT
  appear in any command output or trace.
- Generated command and SDK artifacts MUST remain current, and typecheck, build
  and Biome checks MUST pass.
- Legacy `sde gbp --help` MUST remain present and unchanged.

Run from the repository/worktree root:

```bash
bun run gen:commands
bun test src/apps/google-business-profile src/cli/commands/google-business-profile.test.ts
bun src/cli/index.ts apps check google-business-profile --json
bun src/cli/index.ts gbp --help
bun run sdk:generate
bun run sdk:check
bun run typecheck
bun run build
bunx biome check src/apps/google-business-profile src/cli/commands/google-business-profile.ts src/cli/commands/google-business-profile.test.ts
```

Credential-failure regression with no real backend or network:

```bash
RAVI_STATE_DIR=/tmp/ravi-gbp-empty bun src/cli/index.ts gbp locations --account accounts/000 --json
```

Expected: exit 1 with an actionable missing-credential message before any Google
request. Do not add a token to make this check pass.

Static preservation checks:

```bash
git diff --name-only origin/dev...HEAD
rg -n "sde|gbp-token|business-token" src/apps/google-business-profile src/cli/commands/google-business-profile.ts
```

Expected: no SDE dependency or legacy token path in implementation code.
Mentions in tests/specs may only assert their absence.
