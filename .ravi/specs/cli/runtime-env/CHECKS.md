# Runtime env agent-first CLI contract / CHECKS

## Checks

- `runtime env set OPENAI_API_KEY --value x --json` MUST exit 2 with
  `ENV_KEY_NOT_ALLOWED` and MUST NOT echo the value.
- `runtime env set CLAUDE_CODE_OAUTH_TOKEN --value <token> --json` MUST
  persist the token to `$RAVI_STATE_DIR/.env` with mode `0600` and return
  `value: "[REDACTED]"`.
- `runtime env get CLAUDE_CODE_OAUTH_TOKEN --json` MUST NOT contain the raw
  token.
- `runtime env unset CODEX_HOME --json` MUST remove the assignment and stay
  idempotent when the key is already absent.
- Gateway route table MUST include `/api/v1/runtime/env/set|unset|get`.
- A fixture with live daemon/runner starts older than the env write MUST emit
  warnings naming both processes and their restart commands in JSON and text;
  the secret used in the write MUST be absent from all output.
- `bun test src/runtime/ravi-env-file.test.ts src/cli/commands/runtime-env.test.ts`
  SHOULD pass after any change to this surface.
