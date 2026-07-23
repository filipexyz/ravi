# Slack CLI Agent Actions / CHECKS

## Checks

Use these checks before considering the Slack CLI implemented or changed.

## Static Checks

- `ravi --help` lists `slack`.
- `ravi slack --help` describes Slack management actions, not Ravi diagnostics.
- `ravi slack channels --help` exists.
- `ravi slack channels list --help` shows `--account`, `--limit`, and `--json`.
- `ravi slack channels create --help` shows `--dry-run` and `--apply`.
- `ravi slack messages send --help` shows `--dry-run` and `--apply`.
- Public commands exposed through SDK/OpenAPI declare typed return schemas or
  are explicitly marked CLI-only when not representable as request/response.

## Behavioral Checks

```bash
ravi slack whoami --account <account> --json
ravi slack channels list --account <account> --limit 5 --json
ravi slack channels info --account <account> --channel <channel> --json
ravi slack channels create --account <account> --name <temporary-name> --dry-run --json
ravi slack messages send --account <account> --channel <channel> --text "smoke" --dry-run --json
```

Expected behavior:

- No command prints token values, signing secrets, auth headers, or raw secret
  config.
- Dry-run commands do not mutate Slack.
- Dry-run output includes the Slack method that would be called and says that
  `--apply` is required.
- List output is bounded and has pagination metadata.
- Missing scopes produce actionable errors.

## Regression Scenarios

- A command named `ravi slack routes ...` is introduced. This is a regression
  unless a later spec explicitly changes the boundary.
- A command named `ravi slack chats ...` is introduced. This is a regression
  unless it is renamed to a Slack-native resource action.
- `ravi slack channels create` creates a channel without `--apply`.
- `ravi slack messages send` sends a message during dry-run.
- A Slack API error is printed without method, target, and corrective next step.
