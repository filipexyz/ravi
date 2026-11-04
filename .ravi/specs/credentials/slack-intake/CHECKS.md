# Checks

- `bun test --preload ./src/test/isolated-runtime-preload.ts src/credentials/intake.test.ts src/credentials/backends.test.ts src/credentials/file-backend.test.ts`
- `bun test --preload ./src/test/isolated-runtime-preload.ts src/channels/slack/credential-intake.test.ts src/cli/commands/credential-intake.test.ts`
- Verify native Socket Mode integration consumes reserved callbacks before inbox,
  interaction publication and response-URL registration, including malformed input.
- Verify an env key outside the allowlist and an OAuth destination fail closed.
- Verify only the request endpoint is remotable, and existing add/remove/broker
  `@CliOnly` routes stay absent even with a request capability.
- Verify account/workspace/user/view spoofing, expired requests, permission
  revocation and repeated submissions cannot write a secret.
- Search fake canaries across serialized envelope, ACKs, views, messages, logs,
  trace/event payloads and audit rows; they appear only in the injected secret sink.
- Verify Keychain process arguments/environment/errors contain no secret or
  encoded secret, and oversized stdin commands fail before spawning a process.
- Review the rendered modal prototype at desktop and mobile sizes against
  `design/slack-credential-intake-ux.md`; no real credentials are used.
