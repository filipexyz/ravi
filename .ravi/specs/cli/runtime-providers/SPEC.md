---
id: cli/runtime-providers
title: "Runtime provider auth agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - runtime-providers
  - provider-auth
tags:
  - cli
  - runtime-providers
  - device-login
  - agent-first
  - secret-hygiene
  - gateway
applies_to:
  - src/cli/commands/runtime-providers.ts
  - src/runtime/provider-auth-setup.ts
  - src/runtime/provider-device-login.ts
owners:
  - ravi-dev
status: active
normative: true
---
# Runtime provider auth agent-first CLI contract

## Intent

Let Hub authenticate model providers on a closed Ravi box through the SDK
gateway, without TTY and without reusing `ravi setup` or `ravi login`.

## Surfaces

- `runtime.providers.claude.configure` — token → `CLAUDE_CODE_OAUTH_TOKEN`
  via `runtime.env.set`, then `runtime.credentials.add` pattern
  (`claude-oauth`, secret-env/target-env `CLAUDE_CODE_OAUTH_TOKEN`, agents
  `main`). Optional `agents.set <id> provider claude`.
- `runtime.providers.codex.login` `start|status|complete|cancel` — drive
  `codex login --device-auth`, return `verificationUrl` + `userCode`, then
  import `CODEX_HOME` (`~/.ravi/codex` by default).
- `runtime.providers.grok.login` `start|status|complete|cancel` — same for
  `grok login --device-auth`, then credentials add `--auth-profile`.

## Invariants

1. No TTY prompts. Tokens arrive via `--stdin` or a redacted gateway field.
2. Tokens, rctx keys, and provider secrets MUST NEVER appear in `--json`,
   envelopes, session files, or audit.
3. Device-login session files store only URL, user code, pid, home, and
   status. They MUST NOT store tokens.
4. `complete` before authorization MUST exit 1 with `LOGIN_NOT_READY`
   (`retryable: true`).
5. Mutations are declared unbraked: they exist so Hub can finish auth
   without a confirmation loop.

## Write classification

| op | class | brake |
|---|---|---|
| claude configure | local env + reversible credential add | not braked (declared) |
| login start | spawn helper + persist session | not braked (declared) |
| login complete | import provider-native profile | not braked (declared) |
| login cancel | kill helper | not braked (declared) |
| login status | read | n/a |

## Official error cases

| case | code | exit |
|---|---|---|
| missing token/stdin | `USAGE_ERROR` | 2 |
| login id unknown | `LOGIN_NOT_FOUND` | 1 |
| still pending | `LOGIN_NOT_READY` | 1 |
| helper printed no URL/code | `LOGIN_PROMPT_TIMEOUT` | 1 |
| helper exited / expired | `LOGIN_FAILED` | 1 |
| cancelled | `LOGIN_CANCELLED` | 1 |
| `--set-provider` on missing agent | `AGENT_NOT_FOUND` | 1 |

## Gateway

- `POST /api/v1/runtime/providers/claude/configure`
- `POST /api/v1/runtime/providers/codex/login/start`
- `POST /api/v1/runtime/providers/codex/login/status`
- `POST /api/v1/runtime/providers/codex/login/complete`
- `POST /api/v1/runtime/providers/codex/login/cancel`
- `POST /api/v1/runtime/providers/grok/login/start`
- `POST /api/v1/runtime/providers/grok/login/status`
- `POST /api/v1/runtime/providers/grok/login/complete`
- `POST /api/v1/runtime/providers/grok/login/cancel`
