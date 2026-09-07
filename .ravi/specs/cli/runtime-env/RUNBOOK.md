# Runtime env agent-first CLI contract / RUNBOOK

## Debug Flow

1. `ravi runtime env get CLAUDE_CODE_OAUTH_TOKEN --json` — expect
   `present` / `redacted`, never the token.
2. Unknown key → `ENV_KEY_NOT_ALLOWED` plus `allowedKeys`.
3. After a successful `set`, restart the daemon if the live process still
   has the old env (`daemonReloadRequired: true`).
4. If an envelope ever contains a token, rctx, or secret value, treat that
   as a security regression.

## Validation

```bash
bun test src/runtime/ravi-env-file.test.ts src/cli/commands/runtime-env.test.ts
```

## Hub

`POST /api/v1/runtime/env/set` with Bearer `rctx_*` and body
`{ "key":"CLAUDE_CODE_OAUTH_TOKEN", "value":"<token>", "json":true }`.
Do not put the token in a query string or log line.
