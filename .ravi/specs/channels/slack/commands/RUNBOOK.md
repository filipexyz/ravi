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

## Turn on the message shortcuts

Once per Slack app, at api.slack.com/apps (the reference manifest in
`docs/channels/slack.mdx` has them):

1. **Interactivity & Shortcuts:** with Interactivity on, **Create New Shortcut**,
   **On messages**, three times, with these callback IDs (the names are only what
   people read in the "..." menu):
   - `ravi_status_thread` ("Ravi: status da thread")
   - `ravi_close_thread` ("Ravi: fechar a thread")
   - `ravi_stop_thread` ("Ravi: parar a thread")
2. Reinstall the app when Slack asks (a new shortcut may need it).
3. `ravi channels restart`: from this release the runner publishes the callback id
   of a shortcut, and the daemon answers it.

Check: open the "..." menu of any message in a Ravi thread, pick **Ravi: status
da thread**. A card only you see appears in the thread with its state. Then
**Ravi: fechar a thread**: a card asks first; Cancelar changes nothing.

### A shortcut shows nothing

- The thread has no replies yet: Slack shows an ephemeral message in a thread only
  once it has some. Use `/ravi status <thread>` or the buttons on the thread's card.
- The shortcut is not in the app, or its callback ID is not one of the three: Slack
  runs it and Ravi ignores it. `ravi channels logs` shows nothing for an id Ravi
  does not read; check the ID at api.slack.com/apps.
- "I don't recognize you": the same as for `/ravi`, link the Slack user to a contact.

## Check it works

In a DM with the app, type `/ravi`. The help appears at once, only for you. Then
`/ravi status`. The DM needs the app's Messages Tab on, with users allowed to send
messages and slash commands from it (App Home in the app's settings). Without
it, type the command in a channel the app is in.

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

Every command that reaches the daemon, refused or not, is published on
`ravi.audit.chat_command` with `channel: "slack"` (the same topic any other
channel uses). The runner refuses some commands before it publishes
them (from another workspace, with an origin it could not verify, unreadable, or
with no response URL and no static answer): those appear only in the runner's log
(`ravi channels logs`).

```bash
ravi events replay --subject ravi.audit.chat_command --since 1h
```

Each row has the contact, the Slack user, the chat, the session, the
subcommand, the decision and a result code. The text typed and the thread named
are not in it.

## Validation commands

```bash
bun test src/channels/slack/slash-commands.test.ts
bun test src/channels/slack/slash-command-handler.test.ts
bun test src/channels/slack/interactions.test.ts
bun test src/channels/slack/thread-controls.test.ts src/channels/slack/thread-shortcuts.test.ts
bun test src/cli/command-access.test.ts
bun test src/channels/slack/socket-mode.test.ts -t "slash commands"
```
