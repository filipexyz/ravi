# Google Business Profile Ravi App / RUNBOOK

## Debug Flow

1. Validate discovery without executing app code:

   ```bash
   bun src/cli/index.ts apps check google-business-profile --json
   bun src/cli/index.ts apps show google-business-profile --json
   ```

2. Inspect the command surface without resolving a secret:

   ```bash
   bun src/cli/index.ts gbp --help
   ```

3. If a command fails with a missing-credential error, do not read or import the
   `sde gbp` token files. Credential onboarding belongs to a later approved
   phase; credentials resolve only through the Ravi broker under provider
   `google-business-profile`.

4. If a mock-transport unit test fails, inspect the exact official endpoint,
   method, query and body recorded by the test. The implementation constants and
   request builders are in `src/apps/google-business-profile/client.ts`.

5. If the CLI is absent, run `bun run gen:commands` and verify
   `src/cli/commands/index.ts` exports `google-business-profile.js`. Do not edit
   the barrel manually.

6. If SDK checks fail after a CLI contract change, run `bun run sdk:generate`,
   inspect the generated TypeScript and Swift SDK diffs, then rerun
   `bun run sdk:check`. `GIT_SHA` churn in `version.ts` is masked by the drift
   check and can be ignored.

7. Never debug Phase 1 by running reply, update, delete, create or admin
   mutations against Google. Those paths are validated only with a mock
   transport until separately approved. PINs and secret values must stay
   redacted in every output and trace.
