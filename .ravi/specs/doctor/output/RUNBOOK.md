# Doctor Output / RUNBOOK

## Debug Flow

1. Run `ravi doctor --json` and inspect the JSON contract first.
2. Confirm each check has id, domain, title, status, severity, findings,
   duration, and optional data.
3. For skipped checks, require `data.reason` or an info finding.
4. Compare human output against the JSON result; human text should not invent
   state not present in JSON.
5. Verify exit code mapping: pass, warn, fail, or hard execution error.

## Validation

```bash
bun test src/cli/commands/doctor.test.ts
```
