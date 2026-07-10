# Slack Topology Runbook

## Smoke

```bash
ravi slack topology --channel ravi-rbbt-slack --json
```

## Scope Requirements

- Channel visibility: `conversations:read`-compatible scopes for the app installation.
- Custom sidebar sections are intentionally not read or represented by this command.

## Debug

- Empty channels: confirm the bot can see the workspace/channel type.
- Missing private channel: invite the bot to the private channel.
- Route missing: configure a Ravi route for `group:<channelId>` on the Slack account.
- Route present but `policyGate.inboundAllowed=false`: inspect the Ravi route/policy for the Slack channel config. For allowlisted group policy, a default/account route is not enough; add an explicit route such as `group:<channelId>` or approve the pending chat.
- Newly created Slack channels on an allowlisted Ravi channel SHOULD get an explicit route before expecting inbound agent replies.
- Do not use Slack `usergroups.*` as a proxy for sections. They are a different Slack concept.
