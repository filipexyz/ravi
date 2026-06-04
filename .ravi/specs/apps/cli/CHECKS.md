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

## SDK-Facing Command Drift

When a first-party CLI App command is exposed to SDK/gateway:

```bash
bun run sdk:generate
bun run sdk:check
```

Expected:

- generated SDK files are current;
- command return types are explicit when `@Returns(zod)` is present;
- process/stream/interactive commands are excluded with `@CliOnly()`.

## Context-Key Launch Smoke

For an external CLI App launched by Ravi:

```bash
key="$(ravi context issue my-app --allow view:system:events --ttl 5m --json | jq -r '.context.key')"
RAVI_CONTEXT_KEY="$key" ravi context whoami --json
RAVI_CONTEXT_KEY="$key" ravi context check view system events --json
```

Expected:

- `whoami` resolves a context id;
- check output is structured JSON;
- raw context key is not printed by the app.

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
