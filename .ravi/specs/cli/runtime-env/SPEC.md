---
id: cli/runtime-env
title: "Runtime env agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - runtime-env
tags:
  - cli
  - runtime-env
  - agent-first
  - error-envelope
  - secret-hygiene
  - gateway
applies_to:
  - src/cli/commands/runtime-env.ts
  - src/runtime/ravi-env-file.ts
owners:
  - ravi-dev
status: active
normative: true
---
# Runtime env agent-first CLI contract

## Intent

Give Hub and other closed-box agents a TTY-free way to write the Ravi env
file (`$RAVI_STATE_DIR/.env`, default `~/.ravi/.env`) through the SDK
gateway. This is not `ravi setup` and not `ravi login`.

## Invariants

1. Keys MUST match `^[A-Z][A-Z0-9_]*$` and MUST be in the v1 allowlist.
   Unknown keys fail closed with `ENV_KEY_NOT_ALLOWED` (exit 2).
2. Values MUST NOT contain newlines or NUL. Writes are atomic (temp + rename)
   and the file mode MUST be `0600`.
3. `get` MUST redact secret values (`CLAUDE_CODE_OAUTH_TOKEN`,
   `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`) as `[REDACTED]`.
4. `--value` / gateway body `value` MUST be declared in `@CommandAccess.redactions`.
   Tokens, rctx keys, and secret values MUST NEVER appear in envelopes, audit,
   or `--json` output.
5. Mutations are local and reversible (`unset`). They are declared unbraked.

## Allowlist v1

- `CLAUDE_CODE_OAUTH_TOKEN` — Claude Code OAuth
- `ANTHROPIC_API_KEY` — Anthropic API key
- `ANTHROPIC_AUTH_TOKEN` — Anthropic auth token
- `CODEX_HOME` — Codex isolated profile home
- `GROK_HOME` — Grok isolated profile home
- `GROK_DISABLE_AUTOUPDATER` — disable grok CLI self-update on closed boxes

Extend only in `src/runtime/ravi-env-file.ts` with a comment naming the consumer.

## Write classification

| op | class | brake |
|---|---|---|
| set | local reversible file write | not braked (declared) |
| unset | local reversible file write | not braked (declared) |
| get | read; secrets redacted | n/a |

## Official error cases

| case | code | exit |
|---|---|---|
| unknown key | `ENV_KEY_NOT_ALLOWED` | 2 |
| invalid key shape | `ENV_KEY_INVALID` | 2 |
| empty / newline value | `ENV_VALUE_INVALID` | 2 |
| missing --stdin/--value | `USAGE_ERROR` | 2 |

## Gateway

- `POST /api/v1/runtime/env/set`
- `POST /api/v1/runtime/env/unset`
- `POST /api/v1/runtime/env/get`
