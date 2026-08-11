# Heartbeat agent-first CLI contract / RUNBOOK

## Debug Flow

1. Reproduce with `--json` and branch on `error.code`.
2. Exit 1 with `AGENT_NOT_FOUND`: use a suggested live agent id.
3. Exit 2: correct the call using `acceptedFlags`.
4. `status: skipped`, exit 0: the workspace has no pending heartbeat file;
   do not retry blindly.
5. Exit 3 with `WRITE_REQUIRES_EXECUTE`: inspect the minimal plan and repeat
   with `--execute` only when the queued agent run is intended.

## Common Operations

```bash
ravi heartbeat status --json --fields agent,heartbeat
ravi heartbeat show main --json
ravi heartbeat enable main 30m
ravi heartbeat set main active-hours 09:00-18:00
ravi heartbeat trigger main --execute
ravi daemon logs -f
```

## Validation

```bash
bun test src/cli/commands/heartbeat.test.ts
bun test src/cli/execute-consumers.test.ts
```
