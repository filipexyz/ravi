# Slack CLI Agent Actions / RUNBOOK

## Debug Flow

Use this runbook when implementing or validating `ravi slack`.

## Before Adding A Command

1. Identify the Slack resource being managed: workspace, channel, member,
   message, canvas, work object, file, or interaction surface.
2. Confirm the Slack method and required scopes from Slack's official Web API
   docs.
3. Decide whether the command is read-only, purely local, or an externally
   visible mutation, and add it to the classification table in `SPEC.md`.
4. For mutations, implement the write brake first: local validation, then
   `contractDryRun` (exit 3, `WRITE_REQUIRES_EXECUTE`) BEFORE any Slack Web API
   call, then the real write behind `--execute`. `--execute` is the last
   option of the command.
5. For not-found failures, use `contractFail` with the matching envelope code
   and suggestions from cheap local sources only.
6. Define the JSON return schema before wiring the command into the public CLI.

## Channel Management Smoke Path

Validate with placeholder ids:

```bash
ravi slack permissions-list --channel <channel-config> --json
ravi slack channels-list --channel <channel-config> --limit 10 --json
ravi slack channels-info <channel-id> --channel <channel-config> --json

# Dry-run (expected: exit 3, WRITE_REQUIRES_EXECUTE envelope, NO Slack call)
ravi slack channels-create <temporary-name> --channel <channel-config> --json
ravi slack messages-send <channel-id> "smoke" --channel <channel-config> --json

# Real write (only in an approved test workspace/channel)
ravi slack messages-send <channel-id> "smoke" --channel <channel-config> --json --execute
```

Checking the brake from a shell: `echo $?` right after the dry-run must print
`3`, and the JSON envelope must contain `"code": "WRITE_REQUIRES_EXECUTE"` with
the planned Slack method and request.

## Error Triage

- Exit 3 with `WRITE_REQUIRES_EXECUTE`: not an error. The write brake fired;
  inspect `error.plan` and re-run with `--execute` if the plan is correct.
- `CHANNEL_NOT_FOUND`: the Ravi Slack channel config did not resolve. Check
  `--channel <name>` against `ravi channels list --json`; the envelope's
  `suggestions` lists similar local config names.
- `CREDENTIALS_NOT_CONFIGURED`: the channel config has no working
  `credentialConnection` in the credential broker.
- `MESSAGE_NOT_FOUND`: the replay target ts does not exist in that
  conversation. List candidates with `ravi slack channels-history <channel>
  --json`.
- `CANVAS_NOT_FOUND`: the channel has no resolvable canvas tab. Inspect with
  `ravi slack channels-info <channel> --json`.
- `ARTIFACT_NOT_FOUND`: the canvas artifact id is unknown locally. List with
  `ravi artifacts list --json`; the envelope suggests similar local ids.
- `invalid_auth`: token profile is missing, expired, or points at the wrong
  workspace. Do not print the token.
- `missing_scope`: print the missing scope and the smallest action set that
  needs it. Preflight with `ravi slack permissions-list --json`.
- `channel_not_found` (Slack API error on execute): verify the Slack channel
  id, bot membership, and token class.
- `cannot_unfurl_url`: Work Object unfurls only apply to URLs from real
  `link_shared` events on registered domains.

## Documentation Rule

Runbooks and issues MUST use placeholders such as `<channel-config>`,
`<channel-id>`, `<user>`, and `<ts>`. Do not paste production channel ids,
private messages, tokens, signing secrets, auth headers, or raw Slack payloads
into shared docs.
