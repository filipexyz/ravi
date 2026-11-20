# Runbook

## Turn it on for a Slack app

Once per Slack app, at api.slack.com/apps (see `docs/channels/slack.mdx` for the
reference manifest that already has all of this):

1. **OAuth & Permissions:** add the bot scope `commands`.
2. **Slash Commands:** create the command (`/ravi`, or the name that app should
   have). With Socket Mode no Request URL is needed.
3. Reinstall the app when Slack asks (the new scope needs it once; commands added
   later do not).
4. `ravi channels restart`.

Give each Slack app its own command name. Slash command names are not
namespaced: with two apps registering `/ravi` in one workspace, Slack runs the one
installed most recently.

## Check it works

In a DM with the app, type `/ravi`. The help appears at once, only for you. Then
`/ravi status`.

## Nothing answers

- **Slack says the command failed or timed out:** the runner is not connected
  (`ravi channels status`), or the command is not registered on that app.
- **Slack shows nothing:** `ravi channels logs`. A line
  `Slack slash command refused: its origin is not this instance's` with
  `team_unverified` means the runner could not read its own workspace
  (`auth.test`); with `team_mismatch`, the command came from another workspace
  the app is installed in. `no usable response URL` means Slack sent a URL Ravi
  does not accept.
- **"I don't recognize you in this workspace":** the Slack user is not linked to
  a contact on this instance. `ravi contacts check <contact>`; link with
  `ravi contacts link <contact-id> --channel slack --id U0123ABCD --instance <instance>`.
- **"You do not have access" / "You are not allowed to change":** the contact
  lacks `access` or `modify` on the session of that chat, or, for `close` and
  `stop`, the capability the CLI asks for the operation (the message names it).
  The owner (`permission-owner`) holds all of it.
- **"That command arrived late":** the daemon was down or busy for more than a
  minute. Run it again.
- **"No agent answers in this chat":** the chat has no route:
  `ravi routes explain <instance> group:<channel-id>`.

## See what was run

Every command, refused or not, is published on `ravi.audit.slack_command`:

```bash
ravi events replay --subject ravi.audit.slack_command --since 1h
```

Each row has the contact, the Slack user, the chat, the session, the
subcommand, the decision and a result code. The text typed and the thread named
are not in it.

## Validation commands

```bash
bun test src/channels/slack/slash-commands.test.ts
bun test src/channels/slack/slash-command-handler.test.ts
bun test src/channels/slack/interactions.test.ts
bun test src/cli/command-access.test.ts
bun test src/channels/slack/socket-mode.test.ts -t "slash commands"
```
