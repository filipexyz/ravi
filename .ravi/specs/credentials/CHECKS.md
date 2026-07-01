# Credentials / CHECKS

## Broker Authorization

- All secret resolution MUST go through the broker.
- The broker MUST check authorization before any backend read.
- Callers MUST NOT read secret backends directly.

## Fail-Closed

- The broker MUST fail closed when the connection is disabled, expired, missing, mismatched, or unauthorized.
- Fail-closed errors MUST NOT reveal whether the secret exists or what backend is configured.

## Composite Secrets

- Composite secrets (multiple secret parts under one connection) MUST be resolved atomically.
- Partial resolution MUST fail the entire request.

## Redaction

- Raw secret values MUST NOT appear in SQLite, markdown, runtime context keys, channel config, prompts, logs, traces, events, CLI/JSON output, error messages, or audit records.
- Redacted aliases and secret refs MUST be used wherever a human-readable reference is needed.

## CLI Domain

- The `ravi credentials` CLI is the generic entry point for credential CRUD.
- Domain-specific facades MUST delegate to the generic domain.

## Validation Commands

```bash
ravi specs get credentials --mode full --json
bun run typecheck
bun run build
```
