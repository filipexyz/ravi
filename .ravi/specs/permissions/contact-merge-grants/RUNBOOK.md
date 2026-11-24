# Runbook

- See what the boot repair did: daemon log line "Repaired chat grants left on a merged contact" (source, target, grant id and outcome).
- See it on the contact: `ravi contacts events <target>` lists `permission.grant.merged`.
- A dropped break-glass grant is not restored. If the person needs that power, use `ravi permissions request`.
