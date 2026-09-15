# Devin Sessions Runbook

## Session Lifecycle

1. **Create** — `ravi devin sessions create --prompt "..." --max-acu N --execute`
2. **Monitor** — `ravi devin sessions show <id> --sync --json`
3. **Message** — `ravi devin sessions send <id> "follow-up" --execute`
4. **Sync** — `ravi devin sessions sync <id> --insights --artifacts`
5. **Terminate** — `ravi devin sessions terminate <id>`
6. **Archive** — `ravi devin sessions archive <id> --execute`

## Filtering and Inspection

```bash
# By status
ravi devin sessions list --status running --json

# By tag
ravi devin sessions list --tag deploy --json

# Messages and attachments
ravi devin sessions messages <id> --json
ravi devin sessions attachments <id> --json
```

## Sync and Artifacts

Full sync fetches remote status, messages, attachments, and optionally insights:

```bash
ravi devin sessions sync <id> --insights --artifacts --json
```

This creates a local artifact of kind `devin.session` containing the sync snapshot.

## Identity and Impersonation

Default: sessions are created under the service-user identity.

To attribute to a specific user:
```bash
ravi devin sessions create --prompt "..." --as-user user_abc123 --max-acu 500
```

Or configure a default:
```bash
export DEVIN_DEFAULT_CREATE_AS_USER_ID=user_abc123
```

The service-user must have `ImpersonateOrgSessions` permission.

## Troubleshooting

| Problem | Action |
|---------|--------|
| "DEVIN_DEFAULT_MAX_ACU_LIMIT is not configured" | Set env or use `--max-acu` / `--no-max-acu-limit` |
| Session shows `suspended`/`usage_limit_exceeded` | Raise ACU limit or add org credits |
| `create_as_user_id` rejected | Check service-user has ImpersonateOrgSessions |
| Messages empty after sync | Session may be `new`/`creating` — wait and re-sync |
