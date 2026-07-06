# Why Channel Presence Exists

Presence and runtime status are user-facing trust signals.

Ravi needs a canonical model so WhatsApp typing, Slack assistant status, recording indicators and agent runtime state can be represented without conflating platform presence with delivery receipts or session ownership.

The model must keep status scoped to the correct session and chat/thread so concurrent agents do not leak activity indicators into each other.
