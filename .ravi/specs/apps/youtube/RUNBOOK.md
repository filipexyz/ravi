# YouTube Ravi App / RUNBOOK

## Debug Flow

1. Validate discovery without executing app code:

   ```bash
   bun src/cli/index.ts apps check youtube --json
   bun src/cli/index.ts apps show youtube --json
   ```

2. Inspect Phase 1 readiness without resolving a secret:

   ```bash
   bun src/cli/index.ts yt health --json
   ```

   `authenticated: false` is expected. `ready: true` means only that an active `youtube:<connection>` metadata record exists.

3. If a command fails with `YouTube credential unavailable`, do not read or import the SDE token. Credential onboarding belongs to a later approved phase.

4. If a fake-fetch unit test fails, inspect the exact official endpoint, method, query and body recorded by the test. The implementation constants are in `src/apps/youtube/client.ts`.

5. If the CLI is absent, run `bun run gen:commands` and verify `src/cli/commands/index.ts` exports `youtube.js`. Do not edit the barrel manually.

6. If SDK checks fail after a CLI contract change, run `bun run sdk:generate`, inspect the generated TypeScript and Swift SDK diffs, then rerun `bun run sdk:check`.

7. Never debug Phase 1 by running reply, update, delete, create, add or remove against Google. Those paths are validated only with fake `fetch` until separately approved.
