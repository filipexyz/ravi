# Cron / CHECKS

## List Output MUST Include Target State

```bash
ravi cron list --json --limit 5
```

- Each item in `items[]` and `jobs[]` MUST carry a `targetResolution` field. The check fails if the field is absent.
- Shell jobs without notification targets MUST NOT emit `agent_missing`. The check fails if they do.

## Doctor Cron Targets Check MUST Use Stable IDs

```bash
ravi doctor --json | jq '.checks[] | select(.id == "cron.targets")'
```

- The check id MUST be `cron.targets`. It fails if the check is missing.
- Findings MUST use stable ids (`cron.agent_missing`, `cron.reply_session_missing`, `cron.routing_derived_key`, `cron.routing_unresolved`). The check fails if an unexpected id appears.
- Evidence MUST be bounded (max 20 findings). The check fails if the findings array exceeds the cap.
- Fix hints MUST be safe read-only commands. The check fails if a fix hint suggests a destructive mutation.

## Cron Creation MUST Be Durably Idempotent

- Repeating `cron add` with the same explicit idempotency key and the same normalized input MUST return the original target with `changedCount=0`.
- Reusing an explicit key for different input MUST fail.
- Replaying the same observer rule/source-turn/action after a one-shot target was deleted MUST NOT recreate the cron.
