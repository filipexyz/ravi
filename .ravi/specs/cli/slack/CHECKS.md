# Slack CLI Agent Actions / CHECKS

## Checks

Use these checks before considering the Slack CLI implemented or changed.

## Static Checks

- The root help output (`ravi --help`) MUST list `slack`.
- The domain help (`ravi slack --help`) MUST describe Slack management actions,
  not Ravi diagnostics.
- Every braked command's help (e.g. `ravi slack messages-send --help`) MUST
  show `--execute` as the last option, described as performing the mutation
  with dry-run as the default.
- The main listings (`channels-list`, `channels-history`, `files-list`,
  `canvas-sections-lookup`) MUST show `--fields` in their help output.
- The classification table in `SPEC.md` MUST cover every command in
  `src/cli/commands/slack.ts`, each classified as braked or unbraked.
- Public commands exposed through SDK/OpenAPI MUST declare typed return
  schemas or be explicitly marked CLI-only when not representable.

## Behavioral Checks

```bash
ravi slack permissions-list --channel <channel-config> --json
ravi slack channels-list --channel <channel-config> --limit 5 --fields id,name --json
ravi slack channels-info <channel-id> --channel <channel-config> --json
ravi slack channels-create <temporary-name> --channel <channel-config> --json; echo $?
ravi slack messages-send <channel-id> "smoke" --channel <channel-config> --json; echo $?
ravi slack messages-replay <channel-id> <ts> --channel <channel-config> --json; echo $?
bun test src/cli/commands/slack.test.ts
```

Expected behavior:

- Secret hygiene holds: no command prints token values, signing secrets, auth
  headers, or raw secret config, and modal `private_metadata` MUST be redacted.
- A braked command without `--execute` MUST exit `3` with the
  `WRITE_REQUIRES_EXECUTE` envelope and MUST NOT perform any Slack Web API
  call — including reads (`messages-replay` must not fetch history in
  dry-run).
- The dry-run envelope's `plan` MUST include the Slack method and a safe,
  material-effect summary of the request that `--execute` would send. It MUST
  include the channel-create visibility and name length, rename name length,
  invite user count, and Canvas access level plus target kind/count when
  applicable; it MUST NOT serialize Slack IDs, message text, Markdown, files,
  Block Kit, or other request payload bodies.
- The same braked command with `--execute` MUST perform the Slack call whose
  material effect was described by the plan and return `dryRun: false`.
- An unresolved Ravi channel config MUST exit `1` with `CHANNEL_NOT_FOUND` and
  suggestions computed only from the local config store.
- A missing replay target MUST exit `1` with `MESSAGE_NOT_FOUND`; a missing
  canvas artifact MUST exit `1` with `ARTIFACT_NOT_FOUND` and local artifact
  suggestions.
- Listings with `--fields a,b` MUST narrow the JSON `items` to those fields and
  MUST keep pagination metadata intact.
- Local validation errors (invalid canvas access level, malformed Block Kit
  selection) MUST fail before the brake, without any Slack call.
- The `bun test` suite for `src/cli/commands/slack.test.ts` MUST pass with zero
  failures.

## Regression Scenarios

- A command named `ravi slack routes ...` is introduced. This is a regression
  unless a later spec explicitly changes the boundary.
- A command named `ravi slack chats ...` is introduced. This is a regression
  unless it is renamed to a Slack-native resource action.
- `ravi slack channels-create` creates a channel without `--execute`.
- `ravi slack messages-send` sends a message during dry-run, or a dry-run exits
  `0` instead of `3`.
- `ravi slack messages-replay` performs the `conversations.history` fetch
  before the brake.
- A NOT_FOUND envelope computes suggestions by calling the Slack Web API.
- A Slack API error is printed without method, target, and corrective next
  step.
