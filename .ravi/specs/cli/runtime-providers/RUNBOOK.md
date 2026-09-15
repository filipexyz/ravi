# Runtime provider auth agent-first CLI contract / RUNBOOK

## Claude (token)

```bash
printf '%s' "$TOKEN" | ravi runtime providers claude configure --stdin --json
# Hub:
# POST /api/v1/runtime/providers/claude/configure
# { "token":"...", "json":true, "setProvider":true, "agents":"main" }
```

## Codex / Grok (device code)

1. `POST /api/v1/runtime/providers/codex/login/start` `{ "json":true }`
2. Show `login.verificationUrl` + `login.userCode` in Hub UI.
3. Poll `.../login/status` `{ "id":"<login.id>", "json":true }` until
   `authorized` or `failed`.
4. `POST .../login/complete` `{ "id":"<login.id>", "json":true }`.
5. On abandon: `POST .../login/cancel`.

Same paths under `/api/v1/runtime/providers/grok/login/...`.

Default homes: `$RAVI_STATE_DIR/codex` and `$RAVI_STATE_DIR/grok`
(usually `~/.ravi/codex` and `~/.ravi/grok`). Override with `CODEX_HOME` /
`GROK_HOME` via `runtime.env.set`.

## Validation

```bash
bun test src/runtime/provider-device-login.test.ts src/cli/commands/runtime-providers.test.ts
```
