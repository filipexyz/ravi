---
id: sync/console-bridge
title: "Console Sync Bridge Runbook"
kind: runbook
domain: sync
capability: console-bridge
owners:
  - ravi-dev
status: draft
normative: true
---

# Runbook

## Commands To Add Later

```bash
ravi sync status --json
ravi sync push --domain crm --json
ravi sync pull --domain crm --json
ravi sync retry <event-id> --json
ravi sync inspect <event-id> --json
```

## Debug Upload

1. Run `ravi cloud-auth status`.
2. Inspect local outbox row.
3. Retry with JSON output.
4. Compare idempotency key with Console response.
5. Do not print bearer tokens.

## Debug Download

1. Inspect local cursor.
2. Pull one page.
3. Verify event inserted into local inbox.
4. Apply one event and check projection.
