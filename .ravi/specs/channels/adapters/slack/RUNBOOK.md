# Slack Adapter Runbook

## Local Smoke

1. Add a Slack connection through `ravi credentials`.
2. Set `RAVI_SLACK_SOCKET_MODE=1`.
3. Set `RAVI_SLACK_CONNECTION=<connection>`.
4. Start `ravi channels run` or `ravi channels start`.
5. Send a DM or channel message to the Slack app.
6. Confirm the Ravi session responds in Slack.

## Debug

- No connection: check `ravi credentials connections show`.
- No inbound: check Socket Mode logs and Slack app event subscriptions.
- Wrong thread: check `RAVI_SLACK_SUBSCRIPTION_SCOPE`, `RAVI_SLACK_THREAD_REPLY_MODE`, `RAVI_SLACK_ROOT_REPLY_MODE`.
- Duplicate response: check duplicate runner processes and Socket Mode lock.

