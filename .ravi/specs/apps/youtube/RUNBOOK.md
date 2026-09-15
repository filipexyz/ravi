# YouTube Ravi App / RUNBOOK

## Debug Flow

1. Validate discovery without executing app code:

   ```bash
   bun src/cli/index.ts apps check youtube --json
   bun src/cli/index.ts apps show youtube --json
   ```

2. Verify the public App Router route and its explicit fallback:

   ```bash
   bun src/cli/index.ts youtube health --json
   bun src/cli/index.ts apps run youtube health --json
   ```

   Both commands must resolve operation `youtube.health` and launch the
   manifest implementation `ravi yt health --json`. The public route must not
   add a second YouTube implementation.

3. Inspect the underlying Phase 1 CLI without resolving a secret:

   ```bash
   bun src/cli/index.ts yt health --json
   ```

   `authenticated: false` is expected. `ready: true` means only that an active `youtube:<connection>` metadata record exists.

4. In a Ravi runtime context, inspect the dispatch audit/trace and confirm:

   - caller authorization checked `use app:youtube` or
     `execute app:youtube`;
   - the launched CLI received a fresh child context named `app:youtube`;
   - the child ceiling is exactly `execute:group:yt` and does not exceed the
     parent;
   - the parent context key and synthetic agent/session identity variables were
     not forwarded.

5. If a command fails with `YouTube credential unavailable`, do not read or import the SDE token. Credential onboarding belongs to a later approved phase.

6. If a fake-fetch unit test fails, inspect the exact official endpoint, method, query and body recorded by the test. The implementation constants are in `src/apps/youtube/client.ts`.

7. If the CLI is absent, run `bun run gen:commands` and verify `src/cli/commands/index.ts` exports `youtube.js`. Do not edit the barrel manually.

8. If SDK checks fail after a CLI contract change, run `bun run sdk:generate`, inspect the generated TypeScript and Swift SDK diffs, then rerun `bun run sdk:check`. Generated SDK methods for `ravi yt` are compatibility metadata; app-facing integrations still use the generic App Router.

9. Never debug Phase 1 by running reply, update, delete, create, add or remove against Google. Those paths are validated only with fake `fetch` until separately approved.
