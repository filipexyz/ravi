# Slack Adapter Runbook

## Local Smoke

1. Add a Slack connection through `ravi credentials`.
2. Register or update the Slack channel instance in Ravi.
   - Preferred: credential connection id equals the instance name.
   - Alternative: set instance defaults with `{"slackCredentialConnection":"<connection>"}`.
3. Set `RAVI_SLACK_SOCKET_MODE=1` only while the daemon compatibility path owns Socket Mode.
4. Start `ravi channels run` / `ravi channels start` when the native runner owns adapters, or restart the compatibility daemon while that path exists.
5. Send a DM or channel message to the Slack app.
6. Confirm the Ravi session responds in Slack.

## Debug

- No connection: check the Slack instance and `ravi credentials connections show`.
- No inbound: check Socket Mode logs and Slack app event subscriptions.
- Wrong thread: check `RAVI_SLACK_SUBSCRIPTION_SCOPE`, `RAVI_SLACK_THREAD_REPLY_MODE`, `RAVI_SLACK_ROOT_REPLY_MODE`.
- Duplicate response: check duplicate runner processes and Socket Mode lock.
