# Channel Presence Runbook

1. Resolve the active session and chat/thread before emitting runtime status.
2. Select the latest outbound message from the same session and chat/thread as the preferred anchor.
3. Use a chat/thread transient anchor when no outbound anchor exists and the platform supports it.
4. Clear or expire status on terminal runtime state.
5. Do not use delivery receipts as runtime status.
6. For Slack assistant status, pass the stable Slack thread timestamp, not a moving outbound message id.
