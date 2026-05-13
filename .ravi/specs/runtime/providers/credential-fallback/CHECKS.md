---
id: runtime/providers/credential-fallback
title: "Runtime Provider Credential Fallback Checks"
kind: checks
domain: runtime
owners:
  - ravi-dev
status: draft
normative: false
---

# Checks

## Unit Fixtures

- OpenAI 429 rate limit with `x-ratelimit-*` headers -> `rate_limited`, cooldown from reset/retry headers.
- OpenAI quota or monthly spend exceeded -> `quota_exhausted` or `billing_blocked`, no same-credential retry.
- Anthropic 429 `rate_limit_error` with `retry-after` -> `rate_limited`.
- Anthropic 529 `overloaded_error` -> `provider_overloaded`, no credential exhaustion.
- Google/Vertex 429 `RESOURCE_EXHAUSTED` with quota details -> `rate_limited` or `quota_exhausted`.
- Google/Vertex shared-capacity 429 without key/project quota detail -> provider/capacity classification, no credential exhaustion.
- OpenRouter 402 -> `billing_blocked`.
- OpenRouter 429 -> `rate_limited`.
- Groq 429 with `retry-after` and `x-ratelimit-*` -> `rate_limited`.
- Codex app-server `turn.failed` with structured auth/rate data -> classified.
- Codex unknown app-server error -> `unknown`, no automatic credential rotation.
- Pi RPC failure with upstream status/code/headers -> classified.
- Pi free-form error text -> heuristic with low confidence.
- Permission denied with model/request/safety/provider scope -> no credential retry.
- Permission denied with credential/account entitlement scope -> eligible for credential retry.

## Security Tests

- Raw secret values never appear in runtime traces.
- Raw secret values never appear in `ravi events stream`.
- Raw secret values never appear in daemon logs.
- Raw secret values never appear in `provider.raw` summaries.
- Raw secret values never appear in legacy provider event topics.
- Dynamic secret env names such as `CLAUDE_CODE_OAUTH_TOKEN_1`, `ANTHROPIC_API_KEY_1`, and custom Codex `env_key` values are redacted even when absent from the built-in sanitizer list.
- Codex shell environment does not inherit provider API key env vars by default.
- Claude remote spawn forwards only the selected credential's `remoteForwardEnvKeys`.
- Source secret env names and provider target env names are both redacted.
- Persisted credential rows and secret-binding rows never include resolved provider env values.
- Management CLI JSON redacts secret bindings, secret refs, and values.

## Host Retry Tests

- A pre-tool `rate_limited` failure retries with the next eligible credential and emits only one user-visible response.
- A post-`tool.started` `rate_limited` failure does not auto-replay and surfaces an actionable blocked state.
- Retry uses the materialized failed attempt input and does not consume the next item from the live prompt generator.
- Retry attempts do not duplicate durable user messages.
- Attempts stop at configured maximum.
- Pool exhaustion produces `runtime.credential.pool_empty` and one user-facing failure.
- Manual disable prevents selection immediately.
- Cooldown expiry makes a credential eligible again.
- Resume/fork is allowed when the selected credential compatibility key matches the stored provider session.
- Resume/fork is suppressed when fallback selects a different credential compatibility key.

## Provider Adapter Tests

- Claude selected credential env reaches `buildClaudeCodeEnvironment` without leaking into logs.
- Claude OAuth credential slots are preferred over Anthropic API key slots by default.
- Claude OAuth credential selection strips conflicting `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` from the provider env unless a credential explicitly declares multi-auth.
- Claude API key credential slots are opt-in or explicitly scoped, not the default Claude Code pool shape.
- Claude remote spawn rejects credentials whose selected auth method cannot be forwarded safely.
- Codex selected credential/profile changes the app-server env signature and triggers respawn before retry.
- Codex selected credential/profile mismatch prevents existing thread/session resume.
- Codex shell env allowlist excludes selected credential env keys.
- Pi selected upstream provider/model matches `provider/model` selectors and default provider env.
- Pi classifier receives upstream provider/model on failures.
- Composite credentials with multiple secret bindings are resolved atomically and injected only after every binding is available.

## CLI Tests

- `ravi runtime credentials add/list/status --json` outputs stable redacted JSON.
- `disable` and `enable` update metadata and health deterministically.
- `test` records preflight success/failure without printing secrets.
- Invalid secret refs fail validation before storage.
- `--secret-env <source> --target-env <provider-env>` stores source/target mapping explicitly and injects only the target key into `resolvedEnv`.
- Repeated `--secret-env/--target-env` pairs create one credential with multiple secret bindings.
- Unmatched, duplicated, or order-ambiguous `--secret-env/--target-env` pairs fail validation before storage.

## Manual Smoke

1. Configure two fake credentials for a fake provider test adapter.
2. Force the first credential to emit `rate_limited`.
3. Confirm the host retries once with the second credential.
4. Confirm the trace contains two attempts and one final terminal turn.
5. Confirm no secret literal appears in logs, events, or traces.
