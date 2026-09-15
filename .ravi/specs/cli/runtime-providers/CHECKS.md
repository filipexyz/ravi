# Runtime provider auth agent-first CLI contract / CHECKS

## Checks

- `runtime providers claude configure --token <secret> --json` MUST persist
  `CLAUDE_CODE_OAUTH_TOKEN`, add a `claude-oauth` credential, and MUST NOT
  echo the token in stdout or the credential payload.
- Codex/Grok `login start --json` MUST return `verificationUrl` and
  `userCode` from a fake `--device-auth` helper.
- `login status` after `auth.json` appears MUST report `authorized`.
- `login complete` MUST create a provider-native runtime credential
  (Codex: `codex-profile` / CODEX_HOME; Grok: `--auth-profile`).
- `login complete` while pending MUST exit 1 with `LOGIN_NOT_READY`.
- `login status plogin_missing --json` MUST exit 1 with `LOGIN_NOT_FOUND`.
- Gateway route table MUST include the nine `/api/v1/runtime/providers/...`
  paths listed in SPEC.md.
- `bun test src/runtime/provider-device-login.test.ts src/cli/commands/runtime-providers.test.ts`
  SHOULD pass after any change to this surface.
