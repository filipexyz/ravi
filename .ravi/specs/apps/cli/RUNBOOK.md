# Ravi CLI Apps / RUNBOOK

## Debug Flow

Use this when creating or reviewing a CLI App.

## Create A CLI App

1. Define the app id and domain problem.
2. Model entities, artifacts, lineage, storage, and recovery needs.
3. Decide whether state belongs in domain SQLite, Ravi artifacts, events, or no
   durable store.
4. Design command verbs and examples for humans and agents.
5. Add `--json` to machine-consumed commands.
6. Add bounded list behavior and pagination/page metadata.
7. Define required Ravi capabilities.
8. If the app runs inside Ravi, launch it with a child `RAVI_CONTEXT_KEY`.
9. Write or update the app skill so agents know when to use it.
10. Add checks/tests for the command surface and context behavior.

## First-Party Ravi CLI App

For code inside `src/cli/commands`:

1. Create or update a command file under `src/cli/commands`.
2. Use `@Group`, `@Command`, `@Arg`, and `@Option`.
3. Add `@Returns(zod)` for SDK-facing commands.
4. Mark non-single-shot operations with `@CliOnly()`.
5. Run `bun run gen:commands`.
6. Run the focused command tests.
7. If command metadata is SDK-facing, run `bun run sdk:generate` and
   `bun run sdk:check`.

## External CLI App Launched By Ravi

1. Parent issues a child key:

   ```bash
   ravi context issue <app-id> --allow <permission>:<object-type>:<object-id> --ttl 1h --json
   ```

2. Parent launches the app with only:

   ```bash
   RAVI_CONTEXT_KEY=<rctx_child> <app-command> ...
   ```

3. App resolves identity:

   ```bash
   ravi context whoami --json
   ```

4. App checks or requests capability:

   ```bash
   ravi context check <permission> <object-type> <object-id> --json
   ravi context authorize <permission> <object-type> <object-id> --json
   ```

5. App emits structured JSON output and never prints the raw context key.

## Review A CLI App

Ask:

- Is the app id stable?
- Is there a real domain model?
- Is the command surface concrete?
- Can an agent use `--json` without scraping?
- Are list commands bounded?
- Are permissions least-privilege?
- Is state owned by the domain?
- Does the skill teach operation instead of improvisation?
- Are health/check commands present?
