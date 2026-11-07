# Runtime env agent-first CLI contract / RUNBOOK

## Debug Flow

1. `ravi runtime env get CLAUDE_CODE_OAUTH_TOKEN --json` — expect
   `present` / `redacted`, never the token.
2. Unknown key → `ENV_KEY_NOT_ALLOWED` plus `allowedKeys`.
3. After a successful `set` or `unset`, inspect `warnings`. A newer env file
   leaves live processes stale even when disk and running versions are equal.
   Reconcile the named processes explicitly: `ravi daemon restart -m
   "reload runtime environment"`, then `ravi channels restart` when reported.
   `daemonReloadRequired` refers to the write, not proof that siblings reloaded.
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
