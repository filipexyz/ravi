# Presence Lifecycle / RUNBOOK

## Debug Flow

1. Check runtime turn state for the session.
2. Check whether a terminal event was observed.
3. Check whether presence was stopped on silent/final output.
4. Check whether a delayed renewal fired after terminal state.
5. Verify the target chat/session of each presence event.

## Useful Signals

- Session name
- Channel/account/chat target
- Runtime event type
- Terminal state
- Renewal reason
