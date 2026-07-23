---
id: channels/slack/presence/runbook
title: "Slack Native Presence Runbook"
kind: runbook
domain: channels
capability: slack
feature: presence
status: active
normative: true
---

# Slack Native Presence Runbook

## Verify Native Status

1. Confirm the Slack connection has `chat:write`.
2. Restart the native channels runner with the Slack connection selected.
3. Send a Slack message that routes to a Ravi session.
4. Confirm Slack shows the app working state while the runtime turn is active.
5. Confirm the working state disappears after the answer or terminal turn event.

## Diagnose Fallback

If the native status does not show:

1. Check channel presence diagnostics in the session trace.
2. Look for `assistant.threads.setStatus` errors such as `missing_scope`, `channel_not_found`, or invalid `thread_ts`.
3. Confirm `RAVI_SLACK_REACTION_PRESENCE` is unset or `off` unless an operator is explicitly testing reaction mode.
4. If an old hourglass remains, run the explicit legacy reaction cleanup operation for the affected message timestamps.

## Disable Temporarily

Use this only while debugging a Slack workspace-specific issue:

```bash
RAVI_SLACK_ASSISTANT_STATUS=0
```

Reaction presence is not a fallback. It is available only through explicit operator opt-in with `RAVI_SLACK_REACTION_PRESENCE=always`.
