# Runbook

- See what the boot repair did: daemon log line "Repaired chat grants left on a merged contact" (source, target, grant id and outcome).
- See it on the contact: `ravi contacts timeline <target> --event permission.grant.merged`.
- A dropped break-glass grant is not restored. If the person needs that power, use `ravi permissions request`.
- A row kept as `kept_last_governing_grant` is inert (its contact is gone) and keeps the chat governed by contact grants. Removing it would hand the chat to the agent identity; do that only on purpose, with a replacement grant or knowing the chat falls back.
