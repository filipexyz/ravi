# Runbook: session clone

- Preview: `ravi sessions clone <name> --json` (exit 3, shows origin, agent and how many messages would be copied).
- Run: add `--execute`. In Slack: `/ravi clone <name>` (needs `/ravi` registered as a Slash Command in the Slack app).
- `CLONE_PROVISION_FAILED` with a chat id in the message: the chat exists; check its route with `ravi instances routes list` and the new session with `ravi sessions info <name>`.
- Invite failed: the person joins the channel by hand; nothing else is affected.
