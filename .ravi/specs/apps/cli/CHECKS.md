# Ravi CLI Apps / CHECKS

## Checks

## Spec Exists

```bash
ravi specs get apps/cli --mode rules --json
```

Expected:

- returns inherited `apps` plus `apps/cli` rules;
- includes `RAVI_CONTEXT_KEY`;
- includes `--json`;
- includes bounded list behavior.

## First-Party Command Barrel

When adding a first-party CLI App command file:

```bash
bun run gen:commands
git diff -- src/cli/commands/index.ts
```

Expected:

- the generated barrel includes the new command file;
- no unrelated command exports changed.

## Static Command Compatibility Drift

When the underlying first-party static Ravi command is also exposed to
SDK/gateway:

```bash
bun run sdk:generate
bun run sdk:check
```

Expected:

- generated SDK files are current;
- command return types are explicit when `@Returns(zod)` is present;
- process/stream/interactive commands are excluded with `@CliOnly()`.
- the app manifest still maps the operation to `cli`, and generic App callers
  still use App Router authorization.

## Context-Key Launch Smoke

For an external CLI App launched by Ravi:

```bash
ravi my-app inspect --json
ravi context list --json
ravi context info <child-context-id> --json
```

Expected:

- a fresh child context exists with `issuedFor` equivalent to `app:my-app`;
- its capabilities are no broader than manifest `context.allow`;
- lineage points to the caller context;
- the app process received the child key, not the parent key;
- legacy Ravi identity env vars were not synthesized;
- unrelated parent credentials and secrets were not inherited;
- the command ran with `shell: false` from a bounded app/package root;
- raw context keys are absent from app output and audit.

## Ravi Call Smoke

For an app operation that calls a public Ravi command:

- the app resolves identity through `ravi context whoami`;
- `ravi context check` or `authorize` evaluates the child context;
- the downstream `ravi ...` command succeeds only within the child ceiling;
- an undeclared Ravi capability fails without executing the protected action.

## Agent-First Output Smoke

For each machine-consumed command:

```bash
<app> <command> --json
```

Expected:

- valid JSON;
- includes stable semantic fields;
- error cases return clear messages;
- list commands include page/pagination metadata and are bounded by default.

Also verify that omitting `--json` uses normal human CLI output and does not
change routing, authorization, or child-context behavior.
