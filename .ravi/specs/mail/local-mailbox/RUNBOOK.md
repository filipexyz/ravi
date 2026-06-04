---
id: mail/local-mailbox
title: Local Mailbox Runbook
kind: runbook
domain: mail
capability: local-mailbox
status: draft
normative: false
owners:
  - ravi-dev
---

# Local Mailbox Runbook

## Inspect Status

Expected commands after implementation:

```bash
ravi mail accounts list --json
ravi mail mailboxes list --json
ravi mail providers list --json
ravi mail outbox status --json
```

Status should show active accounts, auth-required providers, pending outbox
rows, failed rows, cursors, and last sanitized error.

## Run One Sync Tick

```bash
ravi mail accounts sync <account-id> --once --json
```

This should pull a bounded provider page, ingest locally, update cursors after
local commit, and publish local mail events.

## Inspect A Message

```bash
ravi mail messages read <local-message-id> --json
```

The output should prefer local ids and include provider ids only as provenance.

## Debug Duplicate Messages

Check these keys:

- `provider + account_id + provider_message_id`
- `mailbox_id + rfc_message_id`
- provider history/event id
- local import idempotency key

If two rows share a provider immutable id for the same account/mailbox, the
ingest path is not idempotent.

## Debug Stuck Outbox

```bash
ravi mail outbox inspect <outbox-id> --json
ravi mail outbox retry <outbox-id> --json
```

Expected fields:

- status
- attempt_count
- next_attempt_at
- last_error_code
- provider_result

The payload must not print provider tokens or raw body content unless explicitly
authorized for local debugging.

## Provider Auth Required

When a provider returns auth errors:

1. local mailbox reads should still work;
2. account status should become `auth_required`;
3. outbox rows should remain retryable;
4. the operator should refresh the existing provider auth path.

Do not create a new token store to fix auth.

## Provider Outage

When a provider is down:

1. local reads/search should keep working;
2. sync runner should back off;
3. new sends should queue in `mail_outbox`;
4. status should show a sanitized provider error code.

## Rebuild Search Projection

If a search projection exists and becomes stale, rebuild from `mail_messages`,
`mail_threads`, `mail_message_addresses`, and `mail_labels`. Do not pull the
entire provider mailbox just to rebuild local search.
