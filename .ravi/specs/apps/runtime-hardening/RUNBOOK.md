# Ravi App Runtime Hardening / RUNBOOK

## Debug Flow

1. Run `ravi apps check <app> --json` to validate declarative metadata only.
2. Run `ravi <app> readiness [app args] --json` to execute declared safe checks.
3. Inspect `errorDetails.code`, `retryable`, `attempts` and `durationMs`.
4. For a blocked write, inspect manifest safety and use either the supported
   `--dry-run` path or an explicitly authorized live command with `--yes`.
5. Never resolve a readiness failure by enabling retries for a mutation.
