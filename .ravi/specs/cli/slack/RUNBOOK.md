# Slack CLI Agent Actions / RUNBOOK

## Debug Flow

Use this runbook when implementing or validating `ravi slack`.

## Before Adding A Command

1. Identify the Slack resource being managed: workspace, channel, member,
   message, reaction, pin, bookmark, file, user, or user group.
2. Confirm the Slack method and required scopes from Slack's official Web API
   docs.
3. Decide whether the command is read-only, mutating, or destructive.
4. For mutating/destructive commands, implement `--dry-run` first and require
   `--apply` for the real call.
5. Define the JSON return schema before wiring the command into the public CLI.

## Channel Management Smoke Path

When the first build slice exists, validate with placeholder ids:

```bash
ravi slack whoami --account <account> --json
ravi slack channels list --account <account> --limit 10 --json
ravi slack channels info --account <account> --channel <channel> --json
ravi slack channels create --account <account> --name <temporary-name> --dry-run --json
ravi slack messages send --account <account> --channel <channel> --text "smoke" --dry-run --json
```

Only run the same commands with `--apply` in an approved test workspace or
approved test channel.

## Error Triage

- `invalid_auth`: token profile is missing, expired, or points at the wrong
  workspace. Do not print the token.
- `missing_scope`: print the missing scope and the smallest action set that
  needs it.
- `channel_not_found`: verify the channel id/name, membership, and token class.
- `not_in_channel`: suggest `ravi slack channels join ... --dry-run` when the
  token is allowed to join.
- `cant_update_message` or `cant_delete_message`: verify the actor owns the
  message or has the Slack permission required for that workspace.

## Documentation Rule

Runbooks and issues MUST use placeholders such as `<account>`, `<channel>`,
`<user>`, and `<ts>`. Do not paste production channel ids, private messages,
tokens, signing secrets, auth headers, or raw Slack payloads into shared docs.
