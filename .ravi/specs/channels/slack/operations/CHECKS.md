# Slack Operations Checks

## Regression Scenarios

- [ ] `ravi slack channels-list --json` returns items and pagination metadata.
- [ ] `ravi slack channels-info <id> --json` returns one channel object.
- [ ] `ravi slack channels-history <id> --json` returns messages without exposing tokens.
- [ ] `ravi slack members-list <id> --json` returns member ids and pagination metadata.
- [ ] `ravi slack files-list --json` returns file metadata without downloading private URLs.
- [ ] `ravi slack permissions-list --json` returns granted OAuth scopes without exposing token values.
- [ ] `ravi slack messages-send <id> <text> --json` is dry-run by default.
- [ ] `ravi slack channels-create <name> --json` is dry-run by default.
- [ ] `ravi slack channels-rename <id> <name> --json` is dry-run by default.
- [ ] `ravi slack channels-invite <id> <user-ids> --json` is dry-run by default.
- [ ] `--execute` is required before mutating Slack.
- [ ] Slack token values never appear in command output or logs.
- [ ] Command access metadata exists for every operation.

## Commands

```bash
bun test src/channels/slack/client.test.ts src/channels/slack/credentials.test.ts
bun run typecheck
bun run build
```
