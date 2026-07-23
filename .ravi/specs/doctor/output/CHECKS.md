# Doctor Output / CHECKS

## Checks

- Doctor JSON MUST be the source of truth for CI, agents, SDK, and human
  projections.
- Each check result MUST include id, domain, title, status, severity, findings,
  durationMs, and optional data.
- Skipped checks MUST include a reason through `data.reason` or an info finding.
- Human output SHOULD be a compact projection of JSON, not a separate contract.
- Exit codes MUST distinguish pass, diagnostic failure, and hard execution
  failure.
- `bun test src/cli/commands/doctor.test.ts` SHOULD pass after changing doctor
  output.
