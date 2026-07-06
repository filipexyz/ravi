# Slack Native Channel Runbook

1. Verify Slack credentials and scopes before enabling native operations.
2. Prefer Socket Mode for initial inbound runtime unless a deployment explicitly selects webhooks.
3. Normalize Slack channel, DM and thread events into Ravi chats/threads before routing.
4. Resolve Slack users into Ravi actors before permission checks.
5. Use native Slack operations for channels, messages, files, Canvas and assistant status.
6. Keep Omni-backed Slack behavior marked as migration compatibility only.
